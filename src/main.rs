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
use std::collections::HashMap;
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
    let state = Arc::new(App { status: Mutex::new(Status { capture: "starting".into(), ..Default::default() }), locked: Mutex::new(false), areas: Mutex::new(HashMap::new()) });
    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![status, overlay_show, overlay_hide, overlay_lock, overlay_locked, overlay_drag, overlay_areas, show_main, open_npcap])
        .setup(move |app| {
            let handle = app.handle().clone();
            for label in OVER_GAME {
                let Some(w) = handle.get_webview_window(label) else { continue };
                // Back where it was left.
                if let Some(p) = place_file(&handle, label).and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice::<Place>(&b).ok()) {
                    let _ = w.set_position(PhysicalPosition::new(p.x, p.y));
                }
                let h2 = handle.clone();
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
                m.on_window_event(move |e| {
                    if let tauri::WindowEvent::CloseRequested { .. } = e {
                        h3.exit(0);
                    }
                });
            }
            follow_cursor(handle.clone(), state.clone());
            start_capture(handle, state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Ludra BR");
}
