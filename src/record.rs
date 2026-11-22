// Recording a fight with Windows' own recorder (Xbox Game Bar, Win+Alt+R):
// nothing to install. Game Bar records the window that has the focus, so the
// game is brought forward first. It always writes into Videos\Captures; when
// the player chose another folder, the finished video (and the fight's log)
// is moved there afterwards. Which files are moved, and how they are named,
// is in ludra_core::recfiles (tested there).

use ludra_core::recfiles::{self, Seen};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The folder Game Bar saves into. Windows keeps it as a known folder of its
/// own ("Captures"), which the player can move through its Properties, even
/// out of Videos; when that is not set, Captures inside Videos.
pub fn captures_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    if let Some(c) = win::known_dir(&windows_sys::Win32::UI::Shell::FOLDERID_AppCaptures) {
        return Some(c);
    }
    #[cfg(windows)]
    if let Some(v) = win::known_dir(&windows_sys::Win32::UI::Shell::FOLDERID_Videos) {
        return Some(v.join("Captures"));
    }
    std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Videos").join("Captures"))
}

/// When the latest recording started (ms since 1970, the page's clock), set
/// by the start key. A finish still waiting for its video uses it so that it
/// never takes the next recording's file.
static LAST_START_MS: AtomicU64 = AtomicU64::new(0);

pub fn started(at: u64) {
    LAST_START_MS.fetch_max(at, Ordering::Relaxed);
}

#[derive(Serialize, Default)]
pub struct Last {
    pub name: String,
    pub bytes: u64,
    /// Seconds since it was last written (a file being recorded keeps growing).
    pub age: f64,
}

/// The newest video in Captures.
pub fn last_video() -> Option<Last> {
    let dir = captures_dir()?;
    let mut best: Option<(SystemTime, Last)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !recfiles::is_video(&name) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let Ok(at) = meta.modified() else { continue };
        if best.as_ref().map_or(true, |(b, _)| at > *b) {
            let age = SystemTime::now().duration_since(at).unwrap_or(Duration::ZERO).as_secs_f64();
            best = Some((at, Last { name, bytes: meta.len(), age }));
        }
    }
    best.map(|(_, l)| l)
}

/// What the page asks for when a recording stops.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishArgs {
    /// When the recording started and stopped (ms since 1970, the page's clock).
    pub since: u64,
    pub until: u64,
    /// The folder the player chose; empty: leave it in Captures.
    #[serde(default)]
    pub dir: String,
    /// Today's folder name ("2026-11-22") when the player wants one per day.
    #[serde(default)]
    pub day: String,
    /// The fight's log, when the player wants it saved with the video.
    #[serde(default)]
    pub log: Option<String>,
    /// The log's name when no video was found to name it after.
    #[serde(default)]
    pub log_name: String,
}

#[derive(Serialize, Default)]
pub struct Finish {
    /// Where the video is now (full path), if one was found.
    pub video: Option<String>,
    pub bytes: u64,
    /// True when it went to another folder than Captures.
    pub moved: bool,
    pub log: Option<String>,
    /// What went wrong, in Portuguese, for the page to show.
    pub problem: Option<String>,
}

/// Game Bar takes a few seconds to write the end of the file after the stop
/// key, more for a long fight. A video that has not shown up by then is not
/// coming (Game Bar off, or the recording never started).
const WAIT_FOR_VIDEO: Duration = Duration::from_secs(45);
/// A video that is there but still held open is waited for this long at most.
const WAIT_FOR_UNLOCK: Duration = Duration::from_secs(240);

fn ms(t: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(t)
}

/// The player-facing reason for an error, never the system's code.
fn why(e: &std::io::Error) -> String {
    recfiles::why(e.kind(), e.raw_os_error()).map(|w| format!(": {w}")).unwrap_or_default()
}

/// Waits for this recording's video to be finished, moves it where the
/// player wants it, and keeps the fight's log next to it. Blocks for up to a
/// few minutes: run it off the main thread.
pub fn finish(a: FinishArgs) -> Finish {
    let mut out = Finish::default();
    let Some(captures) = captures_dir() else {
        out.problem = Some("Pasta de vídeos do Windows não encontrada.".into());
        return out;
    };
    let left = recfiles::folder_label(&captures);
    let base = if a.dir.trim().is_empty() { captures.clone() } else { PathBuf::from(a.dir.trim()) };
    let mut target = recfiles::target_dir(&base, &a.day);
    let mut problems: Vec<String> = Vec::new();
    if let Err(e) = std::fs::create_dir_all(&target) {
        problems.push(format!("Não consegui usar a pasta {}{}. O vídeo fica em {left}.", target.display(), why(&e)));
        target = captures.clone();
    }

    // The log is written now, not when the video is ready: closing the
    // program while it waits must not lose it. It is renamed after the video
    // below, once the video's name is known.
    let mut log: Option<PathBuf> = None;
    if let Some(text) = a.log.as_deref().filter(|t| !t.is_empty()) {
        let name = recfiles::safe_part(&a.log_name);
        let name = if name.is_empty() { "Ludra BR registro.txt".to_string() } else { name };
        let path = recfiles::unique_path(&target, &name, |p| p.exists());
        match std::fs::write(&path, text) {
            Ok(()) => log = Some(path),
            Err(e) => problems.push(format!("Não consegui salvar o registro da luta{}.", why(&e))),
        }
    }

    let (since, until) = (ms(a.since), ms(a.until));
    let started = Instant::now();
    // Size at the last look: the video is taken once it is free and has
    // stopped growing between two looks.
    let mut last_size: Option<(String, u64)> = None;
    loop {
        // Read each time: a new recording may have started meanwhile.
        let next = Some(LAST_START_MS.load(Ordering::Relaxed)).filter(|&n| n > a.until).map(ms);
        let found = this_recording(&captures, since, until, next);
        let waited = started.elapsed();
        let Some(f) = recfiles::pick(&found, since) else {
            if waited > WAIT_FOR_VIDEO {
                break; // none came: the page says so
            }
            std::thread::sleep(Duration::from_secs(1));
            continue;
        };
        let from = captures.join(&f.name);
        let size = std::fs::metadata(&from).map(|m| m.len()).unwrap_or(0);
        let stable = last_size.as_ref() == Some(&(f.name.clone(), size)) && size > 0;
        last_size = Some((f.name.clone(), size));
        let busy = !stable || in_use(&from);
        if !busy && recfiles::same_dir(&target, &captures) {
            out.video = Some(from.to_string_lossy().into());
            out.bytes = size;
            break;
        }
        if !busy {
            let to = recfiles::unique_path(&target, &f.name, |p| p.exists());
            match move_file(&from, &to) {
                Ok(()) => {
                    out.video = Some(to.to_string_lossy().into());
                    out.bytes = size;
                    out.moved = true;
                    break;
                }
                // Opened again by someone: tried again at the next look.
                Err(e) if recfiles::is_busy(e.raw_os_error()) => {}
                // Disk full, no permission, the drive gone: trying again
                // would only copy the whole video again every second.
                Err(e) => {
                    out.video = Some(from.to_string_lossy().into());
                    out.bytes = size;
                    problems.push(format!("Não consegui mover o vídeo{}. Ele ficou em {left}.", why(&e)));
                    break;
                }
            }
        }
        if waited > WAIT_FOR_UNLOCK {
            out.video = Some(from.to_string_lossy().into());
            out.bytes = size;
            problems.push(format!("O vídeo ainda estava sendo salvo. Ele ficou em {left}."));
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }

    // The log takes the video's name and sits next to it.
    if let (Some(path), Some(video)) = (log.as_ref(), out.video.as_deref().map(Path::new)) {
        let dir = video.parent().map(Path::to_path_buf).unwrap_or_else(|| target.clone());
        let name = recfiles::log_name_for(&video.file_name().unwrap_or_default().to_string_lossy());
        let to = recfiles::unique_path(&dir, &name, |p| p.exists());
        if move_file(path, &to).is_ok() {
            log = Some(to);
        }
        // If not, it stays saved under its own name: nothing lost.
    }
    out.log = log.map(|p| p.to_string_lossy().into());
    if !problems.is_empty() {
        out.problem = Some(problems.join(" "));
    }
    out
}

/// The videos in Captures that may be this recording's (never an older one,
/// never one made after the next recording started).
fn this_recording(captures: &Path, since: SystemTime, until: SystemTime, next: Option<SystemTime>) -> Vec<Seen> {
    let Ok(rd) = std::fs::read_dir(captures) else { return Vec::new() };
    rd.flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let f = Seen { name: e.file_name().to_string_lossy().into(), created: meta.created().ok(), modified: meta.modified().ok()? };
            recfiles::is_from(&f, since, until, next).then_some(f)
        })
        .collect()
}

/// Game Bar keeps the file open while it writes it: opening it with no
/// sharing fails until it is done.
#[cfg(windows)]
fn in_use(p: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().read(true).share_mode(0).open(p).is_err()
}
#[cfg(not(windows))]
fn in_use(_: &Path) -> bool {
    false
}

/// A rename when it is the same drive; to another drive, a copy and then the
/// original removed. Nothing is overwritten (the name is checked first).
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    let Err(e) = std::fs::rename(from, to) else { return Ok(()) };
    // ERROR_NOT_SAME_DEVICE on Windows, EXDEV elsewhere.
    let other_drive = e.raw_os_error() == Some(if cfg!(windows) { 17 } else { 18 });
    if !other_drive {
        return Err(e);
    }
    if let Err(e) = std::fs::copy(from, to) {
        let _ = std::fs::remove_file(to);
        return Err(e);
    }
    // Copied: if the original cannot go, both stay, the video is safe.
    let _ = std::fs::remove_file(from);
    Ok(())
}

/// Opens a folder in Explorer, made first if it is not there yet.
pub fn open_folder(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer").arg(dir).spawn();
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::path::PathBuf;
    use windows_sys::core::{GUID, HRESULT, PCWSTR, PWSTR};
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_LCONTROL, VK_LSHIFT,
        VK_LWIN, VK_MENU, VK_RCONTROL, VK_RSHIFT, VK_SHIFT,
    };
    use windows_sys::Win32::UI::Shell::{FileOpenDialog, SHCreateItemFromParsingName, SHGetKnownFolderPath, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, KF_FLAG_DEFAULT, SIGDN_FILESYSPATH};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowTextW, IsWindowVisible, SetForegroundWindow,
    };

    fn title(h: HWND) -> String {
        let mut buf = [0u16; 256];
        let n = unsafe { GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32) }.max(0) as usize;
        String::from_utf16_lossy(&buf[..n])
    }

    /// The game's window: its title starts with "AION2".
    pub fn game_window() -> Option<HWND> {
        unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
            let out = unsafe { &mut *(l as *mut Option<HWND>) };
            if unsafe { IsWindowVisible(h) } != 0 && title(h).starts_with("AION2") {
                *out = Some(h);
                return 0;
            }
            1
        }
        let mut found: Option<HWND> = None;
        unsafe { EnumWindows(Some(each), &mut found as *mut Option<HWND> as LPARAM) };
        found
    }

    fn key(vk: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { 0 }, time: 0, dwExtraInfo: 0 } },
        }
    }

    /// Game in front, then Win+Alt+R. True when the game was found. Can
    /// block for a moment (the game coming to front, keys let go): call it
    /// off the main thread.
    pub fn toggle() -> bool {
        let game = game_window();
        if let Some(h) = game {
            unsafe {
                if GetForegroundWindow() != h {
                    SetForegroundWindow(h);
                    std::thread::sleep(std::time::Duration::from_millis(400));
                }
            }
        }
        // Pressed from our own record key (say Alt+Shift+R), the player is
        // still holding its Shift or Ctrl: Game Bar would see Win+Alt+Shift+R,
        // which is not its record key, and do nothing. So wait (a second at
        // most) for them to be let go. This reads only the keyboard's state.
        let held = || [VK_SHIFT, VK_CONTROL].iter().any(|&vk| (unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000) != 0);
        for _ in 0..50 {
            if !held() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        // Still held: tell Windows they are up before our keys go in.
        let mut seq: Vec<INPUT> = Vec::with_capacity(12);
        if held() {
            for vk in [VK_LSHIFT, VK_RSHIFT, VK_SHIFT, VK_LCONTROL, VK_RCONTROL, VK_CONTROL] {
                seq.push(key(vk, true));
            }
        }
        let r = b'R' as u16;
        seq.extend([key(VK_LWIN, false), key(VK_MENU, false), key(r, false), key(r, true), key(VK_MENU, true), key(VK_LWIN, true)]);
        unsafe { SendInput(seq.len() as u32, seq.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
        game.is_some()
    }

    pub fn game_in_front() -> bool {
        game_window().is_some_and(|h| unsafe { GetForegroundWindow() } == h)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Reads a string the shell allocated, and frees it.
    unsafe fn take(p: PWSTR) -> Option<String> {
        if p.is_null() {
            return None;
        }
        let mut n = 0;
        while unsafe { *p.add(n) } != 0 {
            n += 1;
        }
        let s = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, n) });
        unsafe { CoTaskMemFree(p as *const c_void) };
        Some(s)
    }

    /// A folder Windows keeps track of (Videos, Captures), wherever the
    /// player moved it. None when it is not set or not there.
    pub fn known_dir(id: &GUID) -> Option<PathBuf> {
        let mut p: PWSTR = std::ptr::null_mut();
        let hr = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT as u32, std::ptr::null_mut(), &mut p) };
        let s = unsafe { take(p) }?;
        (hr >= 0 && !s.is_empty()).then(|| PathBuf::from(s)).filter(|d| d.is_dir())
    }

    // windows-sys has the ids but not the COM interfaces, so the two used
    // here are laid out by hand, in the order of shobjidl_core.h. Only the
    // slots called are typed; the others just keep their place.
    const IID_IFILEOPENDIALOG: GUID = GUID::from_u128(0xd57c7288_d4ad_4768_be02_9d969532d960);
    const IID_ISHELLITEM: GUID = GUID::from_u128(0x43826d1e_e718_42ee_bc55_a1e261c37bfe);
    type This = *mut c_void;

    #[repr(C)]
    struct UnknownVtbl {
        _query_interface: usize,
        _add_ref: usize,
        release: unsafe extern "system" fn(This) -> u32,
    }

    #[repr(C)]
    struct FileDialogVtbl {
        base: UnknownVtbl,
        show: unsafe extern "system" fn(This, HWND) -> HRESULT,
        _set_file_types: usize,
        _set_file_type_index: usize,
        _get_file_type_index: usize,
        _advise: usize,
        _unadvise: usize,
        set_options: unsafe extern "system" fn(This, u32) -> HRESULT,
        get_options: unsafe extern "system" fn(This, *mut u32) -> HRESULT,
        _set_default_folder: usize,
        set_folder: unsafe extern "system" fn(This, This) -> HRESULT,
        _get_folder: usize,
        _get_current_selection: usize,
        _set_file_name: usize,
        _get_file_name: usize,
        set_title: unsafe extern "system" fn(This, PCWSTR) -> HRESULT,
        set_ok_button_label: unsafe extern "system" fn(This, PCWSTR) -> HRESULT,
        _set_file_name_label: usize,
        get_result: unsafe extern "system" fn(This, *mut This) -> HRESULT,
    }

    #[repr(C)]
    struct ShellItemVtbl {
        base: UnknownVtbl,
        _bind_to_handler: usize,
        _get_parent: usize,
        get_display_name: unsafe extern "system" fn(This, i32, *mut PWSTR) -> HRESULT,
    }

    unsafe fn vtbl<T>(obj: This) -> &'static T {
        unsafe { &**(obj as *const *const T) }
    }

    /// Windows' own "choose a folder" window (the same as Explorer's), over
    /// `owner`. Opens at `start` when it exists. Ok(None) when cancelled, Err
    /// when the window could not be opened (the page says so).
    /// Runs on a thread of its own, with COM set up as the dialog needs.
    pub fn pick_folder(owner: isize, start: Option<String>) -> Result<Option<String>, String> {
        std::thread::spawn(move || unsafe {
            let inited = CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) >= 0;
            let got = pick_on_this_thread(owner as HWND, start.as_deref());
            if inited {
                CoUninitialize();
            }
            got
        })
        .join()
        .unwrap_or_else(|_| Err("picker thread".into()))
    }

    /// What Show() returns when the player closes the window or clicks Cancel
    /// (HRESULT_FROM_WIN32(ERROR_CANCELLED)).
    const CANCELLED: HRESULT = 0x800704C7u32 as HRESULT;

    unsafe fn pick_on_this_thread(owner: HWND, start: Option<&str>) -> Result<Option<String>, String> {
        let mut dlg: This = std::ptr::null_mut();
        let hr = unsafe { CoCreateInstance(&FileOpenDialog, std::ptr::null_mut(), CLSCTX_INPROC_SERVER, &IID_IFILEOPENDIALOG, &mut dlg) };
        if hr < 0 || dlg.is_null() {
            return Err(format!("CoCreateInstance {hr:#x}"));
        }
        let d: &FileDialogVtbl = unsafe { vtbl(dlg) };
        let mut opts = 0u32;
        unsafe {
            (d.get_options)(dlg, &mut opts);
            (d.set_options)(dlg, opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            let t = wide("Onde salvar os vídeos das lutas");
            (d.set_title)(dlg, t.as_ptr());
            let ok = wide("Usar esta pasta");
            (d.set_ok_button_label)(dlg, ok.as_ptr());
        }
        if let Some(s) = start.filter(|s| std::path::Path::new(s).is_dir()) {
            let w = wide(s);
            let mut item: This = std::ptr::null_mut();
            if unsafe { SHCreateItemFromParsingName(w.as_ptr(), std::ptr::null_mut(), &IID_ISHELLITEM, &mut item) } >= 0 && !item.is_null() {
                unsafe {
                    (d.set_folder)(dlg, item);
                    (vtbl::<ShellItemVtbl>(item).base.release)(item);
                }
            }
        }
        let shown = unsafe { (d.show)(dlg, owner) };
        let got = if shown == CANCELLED {
            Ok(None)
        } else if shown < 0 {
            Err(format!("Show {shown:#x}"))
        } else {
            let mut item: This = std::ptr::null_mut();
            let hr = unsafe { (d.get_result)(dlg, &mut item) };
            if hr < 0 || item.is_null() {
                Err(format!("GetResult {hr:#x}"))
            } else {
                let it: &ShellItemVtbl = unsafe { vtbl(item) };
                let mut p: PWSTR = std::ptr::null_mut();
                let hr = unsafe { (it.get_display_name)(item, SIGDN_FILESYSPATH, &mut p) };
                let path = if hr >= 0 { unsafe { take(p) } } else { None };
                unsafe { (it.base.release)(item) };
                path.filter(|p| !p.is_empty()).map(Some).ok_or_else(|| format!("GetDisplayName {hr:#x}"))
            }
        };
        unsafe { (d.base.release)(dlg) };
        got
    }
}

#[cfg(windows)]
pub use win::{game_in_front, pick_folder, toggle};

#[cfg(not(windows))]
pub fn toggle() -> bool {
    false
}
#[cfg(not(windows))]
pub fn game_in_front() -> bool {
    false
}
#[cfg(not(windows))]
pub fn pick_folder(_owner: isize, _start: Option<String>) -> Result<Option<String>, String> {
    Err("only on Windows".into())
}
