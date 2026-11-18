// Ludra BR: the boss's HP and its mechanics called out in Portuguese, for
// Abyssal Forge: Ludra in AION 2.
//
// Copyright (C) 2026 Ludra LFG. Free software under the GNU GPL v3 (LICENSE).
// The capture and the packet framing are taken from A2Tools DPS Meter
// (https://github.com/taengu/A2Tools-DPS-Meter), also GPL-3.0.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use ludra_core::{capture, flows};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Default, Clone, Serialize)]
struct Status {
    /// "ok", "npcap" (not installed), "devices" (no adapter: run as administrator)
    capture: String,
    detail: String,
    devices: Vec<String>,
    /// The game's stream is found.
    game: bool,
}

#[derive(Default, Serialize, Deserialize, Clone, Copy)]
struct Place {
    x: i32,
    y: i32,
}

struct App {
    status: Mutex<Status>,
    locked: Mutex<bool>,
    /// Where each on-screen window's boxes are, in CSS pixels from its corner:
    /// clicks there move it; everywhere else they go to the game.
    areas: Mutex<HashMap<String, Vec<Area>>>,
    /// The program's windows that have the focus: while one has it, the
    /// player is arranging, and the empty boxes show where things will go.
    focused: Mutex<HashSet<String>>,
    /// The key that opens this window ("Alt+E", or another if that one is taken).
    hotkey: Mutex<String>,
}

#[tauri::command]
fn hotkey_label(state: tauri::State<'_, Arc<App>>) -> String {
    state.hotkey.lock().clone()
}

fn arranging_now(state: &App) -> bool {
    !state.focused.lock().is_empty()
}

fn set_focus(app: &tauri::AppHandle, state: &App, label: &str, on: bool) {
    let before = arranging_now(state);
    if on {
        state.focused.lock().insert(label.to_string());
    } else {
        state.focused.lock().remove(label);
    }
    let after = arranging_now(state);
    if before != after {
        let _ = app.emit("arrange", after);
    }
}

/// True while the player is in the program (its settings or a box), not the game.
#[tauri::command]
fn arranging(state: tauri::State<'_, Arc<App>>) -> bool {
    arranging_now(&state)
}

#[derive(Deserialize, Clone, Copy)]
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The windows drawn over the game: the big text, the damage meter, the boss panel.
const OVER_GAME: [&str; 3] = ["overlay", "meter", "boss"];

fn place_file(app: &tauri::AppHandle, label: &str) -> Option<std::path::PathBuf> {
    let name = if label == "overlay" { "posicao.json".to_string() } else { format!("posicao-{label}.json") };
    app.path().app_config_dir().ok().map(|d| d.join(name))
}

fn over_game(app: &tauri::AppHandle, label: &str) -> Option<WebviewWindow> {
    OVER_GAME.contains(&label).then(|| app.get_webview_window(label)).flatten()
}

#[tauri::command]
fn status(state: tauri::State<'_, Arc<App>>) -> Status {
    state.status.lock().clone()
}

/// Shows a window over the game ("overlay" or "meter") at this size (CSS pixels).
#[tauri::command]
fn overlay_show(app: tauri::AppHandle, width: f64, height: f64, label: Option<String>) {
    let Some(w) = over_game(&app, label.as_deref().unwrap_or("overlay")) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let _ = w.set_size(PhysicalSize::new((width * scale) as u32, (height * scale) as u32));
    let _ = w.show();
    let _ = w.set_always_on_top(true);
}

#[tauri::command]
fn overlay_hide(app: tauri::AppHandle, label: Option<String>) {
    if let Some(w) = over_game(&app, label.as_deref().unwrap_or("overlay")) {
        let _ = w.hide();
    }
}

/// Locked: clicks go through to the game, and nothing can be moved.
#[tauri::command]
fn overlay_lock(app: tauri::AppHandle, state: tauri::State<'_, Arc<App>>, on: bool) {
    *state.locked.lock() = on;
    let _ = app.emit("locked", on);
}

#[tauri::command]
fn overlay_locked(state: tauri::State<'_, Arc<App>>) -> bool {
    *state.locked.lock()
}

#[tauri::command]
fn overlay_areas(window: tauri::Window, state: tauri::State<'_, Arc<App>>, areas: Vec<Area>) {
    state.areas.lock().insert(window.label().to_string(), areas);
}

/// Unlocked, a window over the game takes clicks on its boxes only (to move
/// it), and the rest of it lets them through to the game.
fn follow_cursor(app: tauri::AppHandle, state: Arc<App>) {
    std::thread::spawn(move || {
        let mut ignoring: HashMap<&str, bool> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_millis(60));
            for label in OVER_GAME {
                let Some(w) = app.get_webview_window(label) else { continue };
                if !w.is_visible().unwrap_or(false) {
                    ignoring.remove(label);
                    continue;
                }
                let ignore = if *state.locked.lock() {
                    true
                } else {
                    match (app.cursor_position(), w.outer_position(), w.scale_factor()) {
                        (Ok(c), Ok(p), Ok(s)) => {
                            let (x, y) = ((c.x - p.x as f64) / s, (c.y - p.y as f64) / s);
                            !state.areas.lock().get(label).is_some_and(|v| v.iter().any(|a| x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height))
                        }
                        _ => false,
                    }
                };
                if ignoring.get(label) != Some(&ignore) {
                    ignoring.insert(label, ignore);
                    let _ = w.set_ignore_cursor_events(ignore);
                }
            }
        }
    });
}

#[tauri::command]
fn overlay_drag(window: tauri::Window) {
    if OVER_GAME.contains(&window.label()) {
        let _ = window.start_dragging();
    }
}

#[tauri::command]
fn show_main(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Npcap's download page, in the default browser. The address is fixed here.
#[tauri::command]
fn open_npcap() {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("explorer").arg("https://npcap.com/#download").spawn();
    }
}

const EXE_URL: &str = "https://github.com/ViniRahal/ludra-br/raw/main/download/ludra-br.exe";

/// The new version, in place: the new program is downloaded next to this one
/// (by Windows' own PowerShell), swapped in (Windows lets a running program
/// be renamed), and started; this one closes. No installer, settings kept.
/// Progress and problems go to the page as "update" events.
#[tauri::command]
fn update_now(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let say = |stage: &str, detail: String| {
            let _ = app.emit("update", serde_json::json!({ "stage": stage, "detail": detail }));
        };
        match swap_in_new(&say) {
            Ok(exe) => {
                say("restart", String::new());
                if std::process::Command::new(&exe).spawn().is_ok() {
                    app.exit(0);
                } else {
                    say("error", "A versão nova foi baixada, mas não abriu. Abra o Ludra BR de novo.".into());
                }
            }
            Err(e) => say("error", e),
        }
    });
}

fn swap_in_new(say: &dyn Fn(&str, String)) -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("pasta do programa não encontrada")?.to_path_buf();
    let new = dir.join("ludra-br.new.exe");
    let old = dir.join("ludra-br.old.exe");
    let _ = std::fs::remove_file(&new);
    say("download", String::new());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = format!(
            "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '{EXE_URL}?t={}' -OutFile '{}'",
            capture::now_ms(),
            new.display().to_string().replace('\'', "''")
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Não deu para baixar: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let line = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("erro desconhecido").trim().to_string();
            return Err(format!("Não deu para baixar: {line}"));
        }
    }
    let ok = std::fs::read(&new).map(|b| b.len() > 1_000_000 && b.starts_with(b"MZ")).unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(&new);
        return Err("O arquivo baixado veio incompleto. Tente de novo.".into());
    }
    say("install", String::new());
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| format!("Não deu para trocar o programa: {e}"))?;
    if let Err(e) = std::fs::rename(&new, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("Não deu para trocar o programa: {e}"));
    }
    Ok(exe)
}

/// What an update left behind: the old program, renamed while it ran.
fn clean_after_update() {
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf())) {
        let old = dir.join("ludra-br.old.exe");
        for _ in 0..20 {
            if !old.exists() || std::fs::remove_file(&old).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

/// Alt+E, from anywhere (the game too): opens this window, or tucks it away
/// when it is already in front.
fn hotkey(app: tauri::AppHandle) {
    #[cfg(windows)]
    std::thread::spawn(move || unsafe {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_ALT, MOD_NOREPEAT};
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{MOD_CONTROL, MOD_SHIFT};
        // Alt+E; right after an update the old copy may still hold it a
        // moment. Another program holding it for good (Questlog uses Alt+E
        // too): then Alt+Shift+E, then Ctrl+Alt+E. The page shows which.
        let mut got = None;
        'find: for (mods, label, tries) in [(MOD_ALT, "Alt+E", 16), (MOD_ALT | MOD_SHIFT, "Alt+Shift+E", 1), (MOD_ALT | MOD_CONTROL, "Ctrl+Alt+E", 1)] {
            for _ in 0..tries {
                if RegisterHotKey(std::ptr::null_mut(), 1, mods | MOD_NOREPEAT, 'E' as u32) != 0 {
                    got = Some(label);
                    break 'find;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        let Some(label) = got else { return };
        *app.state::<Arc<App>>().hotkey.lock() = label.to_string();
        let _ = app.emit("hotkey", label);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            if msg.message == WM_HOTKEY {
                if let Some(w) = app.get_webview_window("main") {
                    let front = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false);
                    if front {
                        let _ = w.minimize();
                    } else {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        }
    });
    #[cfg(not(windows))]
    let _ = app;
}

fn start_capture(app: tauri::AppHandle, state: Arc<App>) {
    let (tx, rx) = sync_channel::<flows::Segment>(50_000);
    match capture::start(tx) {
        Ok(devices) => {
            let mut s = state.status.lock();
            s.capture = "ok".into();
            s.devices = devices;
        }
        Err(capture::Problem::NoNpcap) => {
            state.status.lock().capture = "npcap".into();
        }
        Err(capture::Problem::NoDevices(e)) => {
            let mut s = state.status.lock();
            s.capture = "devices".into();
            s.detail = e;
        }
    }
    let _ = app.emit("status", state.status.lock().clone());
    std::thread::Builder::new()
        .name("leitura".into())
        .spawn(move || {
            let mut flows = flows::Flows::with_meter();
            let mut last_view = ludra_core::meter::View::default();
            let mut last_tick = 0i64;
            loop {
                let seg = match rx.recv_timeout(Duration::from_millis(1000)) {
                    Ok(s) => Some(s),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => {
                        // No adapter could be read: nothing will come.
                        std::thread::sleep(Duration::from_secs(3600));
                        continue;
                    }
                };
                let mut changed = None;
                if let Some(seg) = seg {
                    let (mut events, st) = flows.push(&seg);
                    changed = st;
                    // Whom the boss hits: for the meter's aggro, not the page.
                    if let Some(meter) = flows.meter.as_mut() {
                        for e in &events {
                            if let ludra_core::parser::Event::Hit { target, actor } = e {
                                meter.hit(*target, *actor, seg.at_ms);
                            }
                        }
                    }
                    events.retain(|e| !matches!(e, ludra_core::parser::Event::Hit { .. }));
                    if !events.is_empty() {
                        let at = seg.at_ms;
                        let batch: Vec<serde_json::Value> = events
                            .into_iter()
                            .map(|e| {
                                let mut v = serde_json::to_value(e).unwrap_or_default();
                                v["at"] = at.into();
                                v
                            })
                            .collect();
                        let _ = app.emit("pkt", batch);
                    }
                }
                let now = capture::now_ms();
                if now - last_tick >= 1000 {
                    last_tick = now;
                    if let Some(st) = flows.tick(now) {
                        changed = Some(st);
                    }
                    if let Some(meter) = flows.meter.as_mut() {
                        let view = meter.view(now);
                        if view != last_view {
                            let _ = app.emit("meter", &view);
                            last_view = view;
                        }
                    }
                }
                if let Some(st) = changed {
                    let found = matches!(st, flows::Status::Found { .. });
                    let snapshot = {
                        let mut s = state.status.lock();
                        s.game = found;
                        s.clone()
                    };
                    let _ = app.emit("status", snapshot);
                }
            }
        })
        .expect("thread");
}

fn main() {
    let state = Arc::new(App { status: Mutex::new(Status { capture: "starting".into(), ..Default::default() }), locked: Mutex::new(false), areas: Mutex::new(HashMap::new()), focused: Mutex::new(HashSet::new()), hotkey: Mutex::new(String::new()) });
    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![status, overlay_show, overlay_hide, overlay_lock, overlay_locked, overlay_drag, overlay_areas, show_main, open_npcap, arranging, update_now, hotkey_label])
        .setup(move |app| {
            let handle = app.handle().clone();
            for label in OVER_GAME {
                let Some(w) = handle.get_webview_window(label) else { continue };
                // Back where it was left.
                if let Some(p) = place_file(&handle, label).and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice::<Place>(&b).ok()) {
                    let _ = w.set_position(PhysicalPosition::new(p.x, p.y));
                }
                let h2 = handle.clone();
                let s2 = state.clone();
                w.on_window_event(move |e| {
                    if let tauri::WindowEvent::Focused(f) = e {
                        set_focus(&h2, &s2, label, *f);
                    }
                    if let tauri::WindowEvent::Moved(pos) = e {
                        if let Some(f) = place_file(&h2, label) {
                            let _ = std::fs::create_dir_all(f.parent().unwrap());
                            let _ = std::fs::write(f, serde_json::to_vec(&Place { x: pos.x, y: pos.y }).unwrap_or_default());
                        }
                    }
                });
            }
            if let Some(m) = handle.get_webview_window("main") {
                let h3 = handle.clone();
                let s3 = state.clone();
                if m.is_focused().unwrap_or(true) {
                    s3.focused.lock().insert("main".into());
                }
                m.on_window_event(move |e| {
                    if let tauri::WindowEvent::Focused(f) = e {
                        set_focus(&h3, &s3, "main", *f);
                    }
                    if let tauri::WindowEvent::CloseRequested { .. } = e {
                        h3.exit(0);
                    }
                });
            }
            std::thread::spawn(clean_after_update);
            hotkey(handle.clone());
            follow_cursor(handle.clone(), state.clone());
            start_capture(handle, state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Ludra BR");
}
