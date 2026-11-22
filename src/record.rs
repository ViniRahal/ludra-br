// Recording a fight with Windows' own recorder (Xbox Game Bar, Win+Alt+R):
// nothing to install, and the video lands in Videos\Captures. Game Bar
// records the window that has the focus, so the game is brought forward first.

use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

/// The folder Game Bar saves into (Windows' default).
pub fn captures_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Videos").join("Captures"))
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
        if !name.to_ascii_lowercase().ends_with(".mp4") {
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

/// Saves the fight's log next to the videos, so each video has its log.
pub fn save_log(name: &str, text: &str) -> Result<String, String> {
    let dir = captures_dir().ok_or("Pasta de vídeos não encontrada")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '-' }).collect();
    let path = dir.join(safe);
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_LWIN, VK_MENU,
    };
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

    /// Game in front, then Win+Alt+R. True when the game was found.
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
        let r = b'R' as u16;
        let seq = [key(VK_LWIN, false), key(VK_MENU, false), key(r, false), key(r, true), key(VK_MENU, true), key(VK_LWIN, true)];
        unsafe { SendInput(seq.len() as u32, seq.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
        game.is_some()
    }

    pub fn game_in_front() -> bool {
        game_window().is_some_and(|h| unsafe { GetForegroundWindow() } == h)
    }
}

#[cfg(windows)]
pub use win::{game_in_front, toggle};

#[cfg(not(windows))]
pub fn toggle() -> bool {
    false
}
#[cfg(not(windows))]
pub fn game_in_front() -> bool {
    false
}
