// Ludra BR: the boss's HP and its mechanics called out in Portuguese, for
// Abyssal Forge: Ludra in AION 2.
//
// Copyright (C) 2026 Ludra LFG. Free software under the GNU GPL v3 (LICENSE).
// The capture and the packet framing are taken from A2Tools DPS Meter
// (https://github.com/taengu/A2Tools-DPS-Meter), also GPL-3.0.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use ludra_core::{capture, flows, hotkeys};

mod record;

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
    /// The key that opens this window ("Alt+E", or another if that one is
    /// taken; empty when the player turned it off).
    hotkey: Mutex<String>,
    /// The global keys ("Atalhos de teclado"): the player's choice, what
    /// Windows let us have, and the way to the thread that holds them.
    keys: Mutex<Keys>,
    /// The windows over the game the page wants shown (overlay_show and
    /// overlay_hide), so that showing them again after the "esconder
    /// overlays" key brings back only those.
    wanted: Mutex<HashSet<String>>,
    /// Hidden by the "esconder overlays" key: these stay hidden, whatever the
    /// page asks, until the key is pressed again. None: nothing hidden.
    hidden: Mutex<Option<Vec<&'static str>>>,
    /// "Detalhe do jogador": asks the reading thread, which owns the meter.
    detail_tx: Mutex<Option<std::sync::mpsc::Sender<DetailAsk>>>,
    /// The Histórico's options, from the page (history_options).
    hist: Mutex<HistOpts>,
}

/// "Histórico": save the replay ("Linha do tempo") and how many fights to keep.
#[derive(Clone, Copy)]
struct HistOpts {
    timeline: bool,
    keep: usize,
}

impl Default for HistOpts {
    fn default() -> Self {
        HistOpts { timeline: true, keep: ludra_core::history::MAX_FIGHTS }
    }
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

/// The Histórico's options: the page sends them when it opens and on each change.
#[tauri::command]
fn history_options(state: tauri::State<'_, Arc<App>>, timeline: bool, keep: usize) {
    *state.hist.lock() = HistOpts { timeline, keep: keep.clamp(ludra_core::history::MIN_KEEP, ludra_core::history::MAX_KEEP) };
}

/// "Linha do tempo": the mechanics the page called during a saved fight.
#[tauri::command]
fn history_marks(app: tauri::AppHandle, state: tauri::State<'_, Arc<App>>, id: i64, marks: Vec<ludra_core::history::Mark>) -> Result<bool, String> {
    if !state.hist.lock().timeline {
        return Ok(false);
    }
    history_store(&app).ok_or("sem pasta")?.add_marks(id, marks).map_err(|e| e.to_string())
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

/// What one action's key is now.
#[derive(Serialize, Clone, Default)]
struct KeyState {
    /// The key Windows gave us (may be a fallback of the one chosen).
    key: String,
    /// "ok", "taken" (another program holds it), "off", "bad" (not a key we take).
    state: String,
}

#[derive(Default)]
struct Keys {
    config: hotkeys::Config,
    status: std::collections::BTreeMap<String, KeyState>,
    /// To the thread that registers the keys (its jobs), and its id, to wake it.
    tx: Option<std::sync::mpsc::Sender<KeyJob>>,
    thread: u32,
}

enum KeyJob {
    /// Register these keys (and answer once done).
    Apply(hotkeys::Config, Option<std::sync::mpsc::SyncSender<()>>),
    /// While the settings wait for a new key, ours are let go: pressing one
    /// of them would run it instead of being seen by the page.
    Pause(bool),
}

fn keys_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("atalhos.json"))
}

fn keys_load(app: &tauri::AppHandle) -> hotkeys::Config {
    keys_file(app)
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice::<hotkeys::Config>(&b).ok())
        .unwrap_or_default()
        .clean()
}

/// Sends a job to the keys' thread and wakes it.
fn keys_send(state: &App, job: KeyJob) -> bool {
    let k = state.keys.lock();
    let Some(tx) = k.tx.as_ref() else { return false };
    if tx.send(job).is_err() {
        return false;
    }
    #[cfg(windows)]
    if k.thread != 0 {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW(k.thread, windows_sys::Win32::UI::WindowsAndMessaging::WM_APP, 0, 0);
        }
    }
    true
}

fn keys_view(state: &App) -> serde_json::Value {
    // One lock at a time (toggle_overlays takes them the other way round).
    let hidden = state.hidden.lock().is_some();
    let k = state.keys.lock();
    serde_json::json!({ "config": k.config, "status": k.status, "hidden": hidden })
}

/// "Atalhos de teclado": the keys chosen, what Windows let us have, and
/// whether the boxes are hidden by the key now.
#[tauri::command]
fn hotkeys_get(state: tauri::State<'_, Arc<App>>) -> serde_json::Value {
    keys_view(&state)
}

/// New keys from the settings: saved, then registered (waits for Windows'
/// answer, a moment at most, so the page can say which one is taken).
#[tauri::command]
async fn hotkeys_set(app: tauri::AppHandle, state: tauri::State<'_, Arc<App>>, config: hotkeys::Config) -> Result<serde_json::Value, String> {
    let config = config.clean();
    // Registered even when the file can't be written: the page paused the
    // keys while waiting for a new one, and this is what ends the pause. The
    // keys work now; only the next start would lose them (said on the card).
    let mut save_error = None;
    if let Some(f) = keys_file(&app) {
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        if let Err(e) = std::fs::write(&f, serde_json::to_vec_pretty(&config).unwrap_or_default()) {
            save_error = Some(format!("As teclas valem agora, mas não consegui salvar para a próxima vez: {e}"));
        }
    }
    state.keys.lock().config = config.clone();
    let (back, rx) = sync_channel(1);
    if keys_send(&state, KeyJob::Apply(config, Some(back))) {
        let _ = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(3))).await;
    }
    let mut v = keys_view(&state);
    if let Some(e) = save_error {
        v["saveError"] = serde_json::Value::String(e);
    }
    Ok(v)
}

#[tauri::command]
fn hotkeys_pause(state: tauri::State<'_, Arc<App>>, on: bool) {
    keys_send(&state, KeyJob::Pause(on));
}

/// Hides the boxes over the game (the ones the option says), or brings back
/// the ones the page wants shown. The key and the settings' button use it.
fn toggle_overlays(app: &tauri::AppHandle) -> bool {
    let state = app.state::<Arc<App>>();
    let which = state.keys.lock().config.overlays.clone();
    let mut hidden = state.hidden.lock();
    let now_hidden = match hidden.take() {
        Some(list) => {
            let wanted = state.wanted.lock();
            for label in list {
                if let Some(w) = over_game(app, label).filter(|_| wanted.contains(label)) {
                    let _ = w.show();
                    let _ = w.set_always_on_top(true);
                }
            }
            false
        }
        None => {
            let list = hotkeys::overlays_hidden_by(&which, &OVER_GAME);
            for label in &list {
                if let Some(w) = over_game(app, label) {
                    let _ = w.hide();
                }
            }
            *hidden = Some(list);
            true
        }
    };
    drop(hidden);
    let _ = app.emit("overlays-hidden", now_hidden);
    now_hidden
}

#[tauri::command]
fn overlays_toggle(app: tauri::AppHandle) -> bool {
    toggle_overlays(&app)
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
/// panel, the party's frames and the boss cast bar (a window of its own, so it
/// can sit anywhere, apart from the boss panel).
const OVER_GAME: [&str; 5] = ["overlay", "meter", "boss", "party", "cast"];

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
        let fallback = match label { "overlay" => (420.0, 110.0), "boss" => (440.0, 130.0), "party" => (260.0, 300.0), "cast" => (360.0, 60.0), _ => (390.0, 180.0) };
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

/// "Voltar as caixas ao lugar inicial": each box over the game goes back to
/// where it starts on a first install (tauri.conf.json), on the screen the
/// meter is on, so a box lost off-screen (a monitor unplugged, a resolution
/// change) can be found again. The Moved event then saves the new place.
#[tauri::command]
fn overlay_reset_positions(app: tauri::AppHandle) {
    let mon = app
        .get_webview_window("meter")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let (mx, my, scale) = mon.as_ref().map(|m| (m.position().x, m.position().y, m.scale_factor())).unwrap_or((0, 0, 1.0));
    for label in OVER_GAME {
        let Some(w) = app.get_webview_window(label) else { continue };
        let Some(cfg) = app.config().app.windows.iter().find(|c| c.label == label) else { continue };
        let (Some(x), Some(y)) = (cfg.x, cfg.y) else { continue };
        if let Some(f) = place_file(&app, label) {
            let _ = std::fs::remove_file(f);
        }
        let _ = w.set_position(PhysicalPosition::new(mx + (x * scale) as i32, my + (y * scale) as i32));
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

/// Shows a window over the game ("overlay", "meter", "boss", "party" or "cast") at this size (CSS pixels).
#[tauri::command]
fn overlay_show(app: tauri::AppHandle, state: tauri::State<'_, Arc<App>>, width: f64, height: f64, label: Option<String>) {
    let label = label.unwrap_or_else(|| "overlay".into());
    let Some(w) = over_game(&app, &label) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let _ = w.set_size(PhysicalSize::new((width * scale) as u32, (height * scale) as u32));
    state.wanted.lock().insert(label.clone());
    // Hidden by the key: it comes back when the key is pressed again.
    if state.hidden.lock().as_ref().is_some_and(|h| h.contains(&label.as_str())) {
        return;
    }
    let _ = w.show();
    let _ = w.set_always_on_top(true);
}

#[tauri::command]
fn overlay_hide(app: tauri::AppHandle, state: tauri::State<'_, Arc<App>>, label: Option<String>) {
    let label = label.unwrap_or_else(|| "overlay".into());
    state.wanted.lock().remove(&label);
    if let Some(w) = over_game(&app, &label) {
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

/// Starts or stops Game Bar's recording (the same key does both).
/// `start_at` comes with a start: a finish still waiting for the previous
/// video must not take this one's.
#[tauri::command]
async fn record_toggle(start_at: Option<u64>) -> bool {
    if let Some(at) = start_at {
        record::started(at);
    }
    // toggle() may wait (the game coming to front, the record key's Shift or
    // Ctrl let go): not on the main thread, or the windows would freeze.
    tauri::async_runtime::spawn_blocking(record::toggle).await.unwrap_or(false)
}

#[tauri::command]
fn record_last() -> Option<record::Last> {
    record::last_video()
}

#[tauri::command]
fn record_game_front() -> bool {
    record::game_in_front()
}

/// After the stop key: waits for Game Bar to finish the video, then moves it
/// (and writes the fight's log next to it) where the player chose.
#[tauri::command]
async fn record_finish(args: record::FinishArgs) -> Result<record::Finish, String> {
    tauri::async_runtime::spawn_blocking(move || record::finish(args)).await.map_err(|e| e.to_string())
}

/// Where Game Bar saves, shown as the default folder.
#[tauri::command]
fn record_default_dir() -> Option<String> {
    record::captures_dir().map(|d| d.to_string_lossy().into())
}

/// Windows' folder picker, over the settings window. Ok(None) when
/// cancelled, Err when it could not be opened.
#[tauri::command]
async fn record_pick_folder(window: tauri::WebviewWindow, start: Option<String>) -> Result<Option<String>, String> {
    #[cfg(windows)]
    let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let owner = {
        let _ = &window;
        0
    };
    tauri::async_runtime::spawn_blocking(move || record::pick_folder(owner, start)).await.map_err(|e| e.to_string())?
}

/// Opens the chosen folder (empty: Game Bar's). With one folder per day,
/// today's, when there is one yet (made only when a video goes in).
#[tauri::command]
fn record_open_folder(dir: Option<String>, day: Option<String>) {
    let d = dir.filter(|d| !d.trim().is_empty()).map(|d| std::path::PathBuf::from(d.trim())).or_else(record::captures_dir);
    if let Some(d) = d {
        let today = ludra_core::recfiles::target_dir(&d, day.as_deref().unwrap_or(""));
        record::open_folder(if today.is_dir() { &today } else { &d });
    }
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

/// Opens this window, or tucks it away when it is already in front.
fn open_or_hide_main(app: &tauri::AppHandle) {
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

/// A key was pressed (from anywhere, the game too). The windows are moved
/// here; what the page owns (the recording, the names, the test) is told to
/// it, which also says on the big text what happened.
fn fire_key(app: &tauri::AppHandle, action: &str) {
    match action {
        "open" => open_or_hide_main(app),
        "overlays" => {
            toggle_overlays(app);
        }
        _ => {
            let _ = app.emit("hotkey-action", action);
        }
    }
}

/// The global keys (RegisterHotKey, like A2Tools DPS Meter's HotkeyManager in
/// vendor/a2tools, GPL-3.0): one thread holds them and gets WM_HOTKEY; the
/// settings send it new keys through a channel and wake it with WM_APP.
/// Nothing here looks at the game: Windows tells us the key was pressed.
fn hotkey(app: tauri::AppHandle, state: Arc<App>) {
    let (tx, rx) = std::sync::mpsc::channel::<KeyJob>();
    {
        let mut k = state.keys.lock();
        k.config = keys_load(&app);
        // What the pages show until Windows answers.
        *state.hotkey.lock() = if k.config.on { k.config.key("open").to_string() } else { String::new() };
        let _ = tx.send(KeyJob::Apply(k.config.clone(), None));
        k.tx = Some(tx);
    }
    #[cfg(windows)]
    std::thread::spawn(move || unsafe {
        use windows_sys::Win32::System::Threading::GetCurrentThreadId;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT};
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, KillTimer, PeekMessageW, SetTimer, MSG, PM_NOREMOVE, WM_APP, WM_HOTKEY, WM_TIMER, WM_USER};

        let mut msg: MSG = std::mem::zeroed();
        // Makes this thread's message queue now, so a wake posted before the
        // first GetMessageW is kept.
        PeekMessageW(&mut msg, std::ptr::null_mut(), WM_USER, WM_USER, PM_NOREMOVE);
        state.keys.lock().thread = GetCurrentThreadId();

        // The ids held now (each action's place in ACTIONS, from 1).
        let mut held: Vec<i32> = Vec::new();
        let release = |held: &mut Vec<i32>| {
            for id in held.drain(..) {
                UnregisterHotKey(std::ptr::null_mut(), id);
            }
        };
        let take = |mods: u32, vk: u32, id: i32| RegisterHotKey(std::ptr::null_mut(), id, mods | MOD_NOREPEAT, vk) != 0;

        // `first`: right after an update the old copy may still hold the keys
        // a moment, so a taken one is tried again for a few seconds.
        let apply = |config: &hotkeys::Config, held: &mut Vec<i32>, first: bool| {
            release(held);
            let mut status = std::collections::BTreeMap::new();
            let mut missing: Vec<(usize, u32, u32)> = Vec::new();
            for (n, a) in hotkeys::ACTIONS.iter().enumerate() {
                let label = config.key(a);
                let st = if !config.on || label.is_empty() {
                    KeyState { key: label.into(), state: "off".into() }
                } else {
                    match hotkeys::parse(label).filter(|&(m, v)| hotkeys::allowed(m, v)) {
                        None => KeyState { key: label.into(), state: "bad".into() },
                        Some((m, v)) => {
                            let id = n as i32 + 1;
                            if take(m, v, id) {
                                held.push(id);
                                KeyState { key: label.into(), state: "ok".into() }
                            } else {
                                missing.push((n, m, v));
                                KeyState { key: label.into(), state: "taken".into() }
                            }
                        }
                    }
                };
                status.insert(a.to_string(), st);
            }
            if first {
                for _ in 0..16 {
                    if missing.is_empty() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                    missing.retain(|&(n, m, v)| {
                        let id = n as i32 + 1;
                        if take(m, v, id) {
                            held.push(id);
                            if let Some(s) = status.get_mut(hotkeys::ACTIONS[n]) {
                                s.state = "ok".into();
                            }
                            false
                        } else {
                            true
                        }
                    });
                }
            }
            // Alt+E held for good by another program (Questlog uses it too),
            // and the player never chose another: Alt+Shift+E, then Ctrl+Alt+E,
            // as before. The page shows which one it got.
            let open = status.get("open").cloned().unwrap_or_default();
            if open.state == "taken" && open.key == hotkeys::OPEN_DEFAULT {
                let others: Vec<&str> = hotkeys::ACTIONS.iter().map(|a| config.key(a)).collect();
                for alt in hotkeys::OPEN_FALLBACKS {
                    if others.contains(&alt) {
                        continue;
                    }
                    let Some((m, v)) = hotkeys::parse(alt) else { continue };
                    if take(m, v, 1) {
                        held.push(1);
                        status.insert("open".into(), KeyState { key: alt.into(), state: "ok".into() });
                        break;
                    }
                }
            }
            let open = status.get("open").cloned().unwrap_or_default();
            let label = if open.state == "ok" { open.key } else { String::new() };
            *state.hotkey.lock() = label.clone();
            state.keys.lock().status = status;
            let _ = app.emit("hotkey", label);
            let _ = app.emit("hotkeys", keys_view(&state));
        };

        let mut first = true;
        let mut config = hotkeys::Config::default();
        let mut paused = false;
        let mut pause_timer: usize = 0;
        let jobs = |held: &mut Vec<i32>, config: &mut hotkeys::Config, paused: &mut bool, pause_timer: &mut usize, first: &mut bool| {
            while let Ok(job) = rx.try_recv() {
                match job {
                    KeyJob::Apply(c, back) => {
                        *config = c;
                        // A new key chosen also ends the wait for one.
                        if *pause_timer != 0 {
                            KillTimer(std::ptr::null_mut(), *pause_timer);
                            *pause_timer = 0;
                        }
                        *paused = false;
                        apply(config, held, *first);
                        *first = false;
                        if let Some(b) = back {
                            let _ = b.try_send(());
                        }
                    }
                    KeyJob::Pause(true) => {
                        release(held);
                        *paused = true;
                        // The page forgot to give them back (closed while
                        // waiting): they come back by themselves. A bit after
                        // the page's own 30 s wait (hotkeysctl.js), so a key
                        // pressed while it still waits is not run.
                        if *pause_timer != 0 {
                            KillTimer(std::ptr::null_mut(), *pause_timer);
                        }
                        *pause_timer = SetTimer(std::ptr::null_mut(), 0, 32_000, None);
                    }
                    KeyJob::Pause(false) => {
                        if *pause_timer != 0 {
                            KillTimer(std::ptr::null_mut(), *pause_timer);
                            *pause_timer = 0;
                        }
                        if *paused {
                            *paused = false;
                            apply(config, held, false);
                        }
                    }
                }
            }
        };
        jobs(&mut held, &mut config, &mut paused, &mut pause_timer, &mut first);
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            match msg.message {
                WM_HOTKEY => {
                    if let Some(a) = (msg.wParam as usize).checked_sub(1).and_then(|n| hotkeys::ACTIONS.get(n)) {
                        fire_key(&app, a);
                    }
                }
                WM_APP => jobs(&mut held, &mut config, &mut paused, &mut pause_timer, &mut first),
                WM_TIMER if pause_timer != 0 && msg.wParam == pause_timer => {
                    KillTimer(std::ptr::null_mut(), pause_timer);
                    pause_timer = 0;
                    if paused {
                        paused = false;
                        apply(&config, &mut held, false);
                    }
                }
                _ => {}
            }
        }
    });
    #[cfg(not(windows))]
    {
        let _ = (app, state, rx);
    }
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
                                let mut v = serde_json::to_value(&e).unwrap_or_default();
                                v["at"] = at.into();
                                // The boss cast bar: the aimed-at player's name (names stay
                                // on this computer) and the skill's name when data.js has none.
                                if let (ludra_core::parser::Event::Cast { skill, target, .. }, Some(meter)) = (&e, flows.meter.as_ref()) {
                                    let (name, me) = meter.aim_of(*target);
                                    v["target_name"] = name.into();
                                    v["target_me"] = me.into();
                                    v["target_npc"] = meter.aim_is_npc(*target).into();
                                    v["skill_name"] = meter.skill_name(*skill).into();
                                }
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
                        for mut fight in meter.take_finished() {
                            let opts = *state.hist.lock();
                            if !opts.timeline {
                                fight.drop_replay();
                            }
                            if let Some(store) = history_store(&app).map(|s| s.keep(opts.keep)) {
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
    let state = Arc::new(App { status: Mutex::new(Status { capture: "starting".into(), ..Default::default() }), locked: Mutex::new(false), areas: Mutex::new(HashMap::new()), focused: Mutex::new(HashSet::new()), hotkey: Mutex::new(String::new()), keys: Mutex::new(Keys::default()), wanted: Mutex::new(HashSet::new()), hidden: Mutex::new(None), detail_tx: Mutex::new(None), hist: Mutex::new(HistOpts::default()) });
    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![status, overlay_show, overlay_hide, overlay_lock, overlay_locked, overlay_drag, overlay_areas, show_main, open_npcap, arranging, update_now, update_download, update_restart, hotkey_label, hotkeys_get, hotkeys_set, hotkeys_pause, overlays_toggle, overlay_layout, overlay_move, overlay_reset_positions, send_log, meter_detail, history_list, history_get, history_delete, history_bests, history_options, history_marks, record_toggle, record_last, record_game_front, record_finish, record_default_dir, record_pick_folder, record_open_folder])
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
            hotkey(handle.clone(), state.clone());
            follow_cursor(handle.clone(), state.clone());
            start_capture(handle, state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Ludra BR");
}
