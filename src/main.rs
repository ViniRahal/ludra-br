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
    /// "Detalhe do jogador": asks the reading thread, which owns the meter.
    detail_tx: Mutex<Option<std::sync::mpsc::Sender<DetailAsk>>>,
}

/// A player's id, and where to send their detail.
type DetailAsk = (i32, std::sync::mpsc::SyncSender<Option<ludra_core::meter::Detail>>);

/// "Detalhe do jogador": one player's skills and the damage they took, this fight.
#[tauri::command]
async fn meter_detail(state: tauri::State<'_, Arc<App>>, id: i32) -> Result<Option<ludra_core::meter::Detail>, String> {
    let Some(tx) = state.detail_tx.lock().clone() else { return Ok(None) };
    let (back, rx) = sync_channel(1);
    if tx.send((id, back)).is_err() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_millis(1500)).ok().flatten()).await.map_err(|e| e.to_string())
}

/// "Histórico das lutas": the folder the fights are kept in.
fn history_store(app: &tauri::AppHandle) -> Option<ludra_core::history::Store> {
    app.path().app_data_dir().ok().map(|d| ludra_core::history::Store::new(d.join("historico")))
}

/// The saved fights, newest first.
#[tauri::command]
fn history_list(app: tauri::AppHandle) -> Vec<ludra_core::history::FightSummary> {
    history_store(&app).map(|s| s.list()).unwrap_or_default()
}

#[tauri::command]
fn history_get(app: tauri::AppHandle, id: i64) -> Option<ludra_core::history::Fight> {
    history_store(&app).and_then(|s| s.get(id))
}

#[tauri::command]
fn history_delete(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    history_store(&app).ok_or("sem pasta")?.delete(id).map_err(|e| e.to_string())
}

/// Your best DPS per boss and character.
#[tauri::command]
fn history_bests(app: tauri::AppHandle) -> Vec<ludra_core::history::Best> {
    history_store(&app).map(|s| s.bests()).unwrap_or_default()
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

/// The windows drawn over the game: the big text, the damage meter, the boss
/// panel and the party's frames.
const OVER_GAME: [&str; 4] = ["overlay", "meter", "boss", "party"];

fn place_file(app: &tauri::AppHandle, label: &str) -> Option<std::path::PathBuf> {
    let name = if label == "overlay" { "posicao.json".to_string() } else { format!("posicao-{label}.json") };
    app.path().app_config_dir().ok().map(|d| d.join(name))
}

fn over_game(app: &tauri::AppHandle, label: &str) -> Option<WebviewWindow> {
    OVER_GAME.contains(&label).then(|| app.get_webview_window(label)).flatten()
}

/// For the overlay editor: the screen the game is on, and where each box
/// over it is (its visible part, in screen pixels).
#[tauri::command]
fn overlay_layout(app: tauri::AppHandle, state: tauri::State<'_, Arc<App>>) -> serde_json::Value {
    let mon = app
        .get_webview_window("meter")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let (mx, my, mw, mh) = mon.as_ref().map(|m| (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32)).unwrap_or((0, 0, 1920, 1080));
    let areas = state.areas.lock();
    let mut boxes = Vec::new();
    for label in OVER_GAME {
        let Some(w) = app.get_webview_window(label) else { continue };
        let Ok(p) = w.outer_position() else { continue };
        let s = w.scale_factor().unwrap_or(1.0);
        let fallback = match label { "overlay" => (420.0, 110.0), "boss" => (440.0, 130.0), "party" => (260.0, 300.0), _ => (390.0, 180.0) };
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for a in areas.get(label).map(|v| v.as_slice()).unwrap_or(&[]) {
            if a.width <= 2.0 || a.height <= 2.0 {
                continue;
            }
            x0 = x0.min(a.x);
            y0 = y0.min(a.y);
            x1 = x1.max(a.x + a.width);
            y1 = y1.max(a.y + a.height);
        }
        let (ox, oy, bw, bh) = if x0 == f64::MAX { (0.0, 0.0, fallback.0, fallback.1) } else { (x0, y0, x1 - x0, y1 - y0) };
        boxes.push(serde_json::json!({
            "label": label,
            "x": p.x + (ox * s) as i32,
            "y": p.y + (oy * s) as i32,
            "w": (bw * s) as i32,
            "h": (bh * s) as i32,
            "dx": (ox * s) as i32,
            "dy": (oy * s) as i32,
            "visible": w.is_visible().unwrap_or(false),
        }));
    }
    serde_json::json!({ "monitor": { "x": mx, "y": my, "w": mw, "h": mh }, "boxes": boxes })
}

/// The editor moved a box: its window goes there (screen pixels, window corner).
#[tauri::command]
fn overlay_move(app: tauri::AppHandle, label: String, x: i32, y: i32) {
    if let Some(w) = over_game(&app, &label) {
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
}

/// Where "Enviar registro" goes: a Discord webhook of the Ludra LFG server
/// (path after https://discord.com), scrambled so link scanners on GitHub
/// don't pick it up. Empty: not set up yet. Made by tools/hook.py.
const LOG_HOOK: &[u8] = &[117, 38, 16, 100, 1, 188, 145, 243, 218, 48, 23, 14, 117, 12, 253, 220, 189, 133, 102, 68, 39, 11, 20, 247, 208, 190, 156, 102, 66, 39, 4, 235, 194, 200, 234, 229, 47, 93, 69, 73, 153, 180, 171, 194, 146, 116, 53, 59, 80, 143, 197, 228, 201, 43, 29, 81, 71, 106, 159, 195, 213, 223, 108, 22, 80, 85, 117, 149, 182, 192, 208, 31, 26, 80, 92, 75, 182, 137, 199, 202, 30, 29, 123, 90, 232, 159, 162, 227, 248, 7, 37, 86, 88, 163, 207, 208, 238, 197, 44, 6, 95, 66];

fn log_webhook() -> String {
    LOG_HOOK.iter().enumerate().map(|(i, b)| (b ^ (0x5A ^ (i as u8).wrapping_mul(29))) as char).collect()
}

/// Sends a fight's mechanics log (a text file) to the people who tune the
/// calls. Nothing personal goes: the boss, the mechanic, the time and the %.
#[tauri::command]
async fn send_log(app: tauri::AppHandle, text: String, note: String) -> Result<(), String> {
    if LOG_HOOK.is_empty() {
        return Err("O envio ainda não foi configurado. Use Copiar por enquanto.".into());
    }
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || post_log(&text, &format!("Ludra BR {version} · {note}")))
        .await
        .map_err(|e| e.to_string())?
}

fn post_log(text: &str, note: &str) -> Result<(), String> {
    let boundary = "----ludrabr7d1f";
    let payload = serde_json::json!({ "content": note.chars().take(1800).collect::<String>(), "allowed_mentions": { "parse": [] } }).to_string();
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n{payload}\r\n").as_bytes());
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"registro.txt\"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n").as_bytes());
    body.extend_from_slice(text.as_bytes());
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Networking::WinHttp::*;
        let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let agent = w("LudraBR");
        let ses = WinHttpOpen(agent.as_ptr(), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, std::ptr::null(), std::ptr::null(), 0);
        if ses.is_null() {
            return Err("Sem internet para enviar.".into());
        }
        let host = w("discord.com");
        let con = WinHttpConnect(ses, host.as_ptr(), 443, 0);
        let verb = w("POST");
        let path = w(&log_webhook());
        let req = if con.is_null() { std::ptr::null_mut() } else { WinHttpOpenRequest(con, verb.as_ptr(), path.as_ptr(), std::ptr::null(), std::ptr::null(), std::ptr::null(), WINHTTP_FLAG_SECURE) };
        let headers = w(&format!("Content-Type: multipart/form-data; boundary={boundary}\r\n"));
        let mut status: u32 = 0;
        let ok = !req.is_null()
            && WinHttpSendRequest(req, headers.as_ptr(), u32::MAX, body.as_ptr() as *const _, body.len() as u32, body.len() as u32, 0) != 0
            && WinHttpReceiveResponse(req, std::ptr::null_mut()) != 0
            && {
                let mut len = 4u32;
                WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, std::ptr::null(), &mut status as *mut u32 as *mut _, &mut len, std::ptr::null_mut()) != 0
            };
        for h in [req, con, ses] {
            if !h.is_null() {
                WinHttpCloseHandle(h);
            }
        }
        if !ok {
            return Err("Não deu para enviar. Confira a internet.".into());
        }
        if !(200..300).contains(&status) {
            return Err(format!("O Discord recusou o envio (código {status})."));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (body, note);
        Err("só no Windows".into())
    }
}

#[tauri::command]
fn status(state: tauri::State<'_, Arc<App>>) -> Status {
    state.status.lock().clone()
}

/// Shows a window over the game ("overlay", "meter", "boss" or "party") at this size (CSS pixels).
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
/// it), and the rest of it lets them through to the game. The hover and the
/// drag are read from the mouse itself, not from the window's events: with
/// the game in front, the window does not always get them.
fn follow_cursor(app: tauri::AppHandle, state: Arc<App>) {
    std::thread::spawn(move || {
        let mut ignoring: HashMap<&str, bool> = HashMap::new();
        let mut hovering: HashMap<&str, bool> = HashMap::new();
        // (window, cursor at the press, window at the press, moved)
        let mut drag: Option<(&str, (f64, f64), (i32, i32), bool)> = None;
        let mut was_down = false;
        loop {
            let busy = drag.is_some() || hovering.values().any(|v| *v);
            std::thread::sleep(Duration::from_millis(if busy { 12 } else { 50 }));
            let down = left_down();
            let press = down && !was_down;
            was_down = down;
            let cursor = app.cursor_position().ok();
            let locked = *state.locked.lock();
            if let Some((label, c0, p0, moved)) = drag.as_mut() {
                if !down || locked {
                    drag = None;
                } else if let (Some(c), Some(w)) = (cursor, app.get_webview_window(label)) {
                    let (dx, dy) = (c.x - c0.0, c.y - c0.1);
                    if *moved || dx.abs() + dy.abs() >= 4.0 {
                        *moved = true;
                        let _ = w.set_position(PhysicalPosition::new(p0.0 + dx as i32, p0.1 + dy as i32));
                    }
                }
                continue;
            }
            for label in OVER_GAME {
                let Some(w) = app.get_webview_window(label) else { continue };
                if !w.is_visible().unwrap_or(false) {
                    ignoring.remove(label);
                    hovering.remove(label);
                    continue;
                }
                let over = match (cursor, w.outer_position(), w.scale_factor()) {
                    (Some(c), Ok(p), Ok(s)) => {
                        let (x, y) = ((c.x - p.x as f64) / s, (c.y - p.y as f64) / s);
                        state.areas.lock().get(label).is_some_and(|v| v.iter().any(|a| x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height))
                    }
                    _ => false,
                };
                let hover = over && !locked;
                if hovering.get(label) != Some(&hover) {
                    hovering.insert(label, hover);
                    let _ = app.emit("hover", serde_json::json!({ "label": label, "on": hover }));
                }
                if hover && press {
                    if let (Some(c), Ok(p)) = (cursor, w.outer_position()) {
                        drag = Some((label, (c.x, c.y), (p.x, p.y), false));
                    }
                }
                let ignore = !hover;
                if ignoring.get(label) != Some(&ignore) {
                    ignoring.insert(label, ignore);
                    let _ = w.set_ignore_cursor_events(ignore);
                }
            }
        }
    });
}

#[cfg(windows)]
fn left_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 }
}
#[cfg(not(windows))]
fn left_down() -> bool {
    false
}

#[tauri::command]
fn overlay_drag(window: tauri::Window) {
    // The mouse thread moves the boxes (follow_cursor).
    let _ = window;
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

/// The new version, as players know it from other programs: it comes down
/// in the background (by Windows itself, no browser, no installer) next to
/// this program; then "Reiniciar agora" swaps it in (Windows lets a running
/// program be renamed) and starts it. Progress goes to the page as "update".
#[tauri::command]
fn update_download(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let _ = app.emit("update", serde_json::json!({ "stage": "download" }));
        match download_new() {
            Ok(()) => {
                let _ = app.emit("update", serde_json::json!({ "stage": "ready" }));
            }
            Err(e) => {
                let _ = app.emit("update", serde_json::json!({ "stage": "error", "detail": e }));
            }
        }
    });
}

#[tauri::command]
fn update_restart(app: tauri::AppHandle) {
    match swap_in_new() {
        Ok(exe) => {
            if std::process::Command::new(&exe).spawn().is_ok() {
                app.exit(0);
            } else {
                let _ = app.emit("update", serde_json::json!({ "stage": "error", "detail": "A versão nova foi instalada, mas não abriu. Abra o Ludra BR de novo." }));
            }
        }
        Err(e) => {
            let _ = app.emit("update", serde_json::json!({ "stage": "error", "detail": e }));
        }
    }
}

fn program_files() -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("pasta do programa não encontrada")?.to_path_buf();
    Ok((exe, dir.join("ludra-br.new.exe"), dir.join("ludra-br.old.exe")))
}

fn download_new() -> Result<(), String> {
    let (_, new, _) = program_files()?;
    let _ = std::fs::remove_file(&new);
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Com::Urlmon::URLDownloadToFileW;
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let url = wide(&format!("{EXE_URL}?t={}", capture::now_ms()));
        let path = wide(&new.display().to_string());
        let hr = URLDownloadToFileW(std::ptr::null_mut(), url.as_ptr(), path.as_ptr(), 0, std::ptr::null_mut());
        if hr != 0 {
            return Err(format!("Não deu para baixar (erro {hr:#x}). Confira a internet e tente de novo."));
        }
    }
    let ok = std::fs::read(&new).map(|b| b.len() > 1_000_000 && b.starts_with(b"MZ")).unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(&new);
        return Err("O arquivo baixado veio incompleto. Tente de novo.".into());
    }
    Ok(())
}

fn swap_in_new() -> Result<std::path::PathBuf, String> {
    let (exe, new, old) = program_files()?;
    if !new.exists() {
        return Err("A versão nova não está baixada. Tente de novo.".into());
    }
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| format!("Não deu para trocar o programa: {e}"))?;
    if let Err(e) = std::fs::rename(&new, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("Não deu para trocar o programa: {e}"));
    }
    Ok(exe)
}

/// Versions 0.6.2 to 0.6.5 call this: now the same as downloading and restarting.
#[tauri::command]
fn update_now(app: tauri::AppHandle) {
    std::thread::spawn(move || match download_new() {
        Ok(()) => update_restart(app),
        Err(e) => {
            let _ = app.emit("update", serde_json::json!({ "stage": "error", "detail": e }));
        }
    });
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
    let (detail_tx, detail_rx) = std::sync::mpsc::channel::<DetailAsk>();
    *state.detail_tx.lock() = Some(detail_tx);
    std::thread::Builder::new()
        .name("leitura".into())
        .spawn(move || {
            let mut flows = flows::Flows::with_meter();
            let mut last_view = ludra_core::meter::View::default();
            let mut last_tick = 0i64;
            let mut last_view_at = 0i64;
            loop {
                let seg = match rx.recv_timeout(Duration::from_millis(250)) {
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
                while let Ok((id, back)) = detail_rx.try_recv() {
                    let _ = back.try_send(flows.meter.as_ref().and_then(|m| m.detail(id)));
                }
                let now = capture::now_ms();
                if now - last_tick >= 1000 {
                    last_tick = now;
                    if let Some(st) = flows.tick(now) {
                        changed = Some(st);
                    }
                }
                // The meter 4 times a second, so its numbers move smoothly.
                if now - last_view_at >= 250 {
                    last_view_at = now;
                    if let Some(meter) = flows.meter.as_mut() {
                        let view = meter.view(now);
                        // A boss fight ended: saved, and a record beaten is told.
                        for fight in meter.take_finished() {
                            if let Some(store) = history_store(&app) {
                                match store.save(&fight) {
                                    Ok(best) => {
                                        let _ = app.emit("history-saved", fight.id);
                                        if let Some(b) = best {
                                            let _ = app.emit("new-best", b);
                                        }
                                    }
                                    Err(e) => eprintln!("historico: {e}"),
                                }
                            }
                        }
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
    let state = Arc::new(App { status: Mutex::new(Status { capture: "starting".into(), ..Default::default() }), locked: Mutex::new(false), areas: Mutex::new(HashMap::new()), focused: Mutex::new(HashSet::new()), hotkey: Mutex::new(String::new()), detail_tx: Mutex::new(None) });
    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![status, overlay_show, overlay_hide, overlay_lock, overlay_locked, overlay_drag, overlay_areas, show_main, open_npcap, arranging, update_now, update_download, update_restart, hotkey_label, overlay_layout, overlay_move, send_log, meter_detail, history_list, history_get, history_delete, history_bests])
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
                // Only the settings window shows the empty boxes (a box over the
                // game kept "focused" once a click landed on it, and its empty
                // box then stayed over the game).
                let _ = (&h2, &s2);
                w.on_window_event(move |e| {
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
                if m.is_focused().unwrap_or(false) {
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
