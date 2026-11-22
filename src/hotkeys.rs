//! The global keys ("Atalhos de teclado"): which actions there are, the
//! player's choice of key for each, and turning a key's name ("Ctrl+Alt+R")
//! into what Windows' RegisterHotKey takes. No window and no Windows call in
//! here, so it is tested anywhere (`cargo test`); main.rs registers the keys.
//!
//! The key names follow A2Tools DPS Meter's parse_hotkey_label
//! (vendor/a2tools/src-tauri/src/platform/hotkeys.rs, GPL-3.0), with the
//! numpad and F13 to F24 added. ui/hotkeys.js writes the same names.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Win32's MOD_* flags (what RegisterHotKey takes).
pub const MOD_ALT: u32 = 0x0001;
pub const MOD_CONTROL: u32 = 0x0002;
pub const MOD_SHIFT: u32 = 0x0004;
pub const MOD_WIN: u32 = 0x0008;

/// The actions, in the order the settings list them. Each one's place in this
/// list (from 1) is its id with RegisterHotKey.
pub const ACTIONS: [&str; 5] = ["open", "record", "overlays", "names", "test"];

/// The key that opens the settings, as it always was.
pub const OPEN_DEFAULT: &str = "Alt+E";

/// When Alt+E is held by another program (Questlog uses it too) and the
/// player never chose another key, these are tried, as before.
pub const OPEN_FALLBACKS: [&str; 2] = ["Alt+Shift+E", "Ctrl+Alt+E"];

/// What the player set: saved as atalhos.json next to the boxes' positions.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Config {
    /// All the keys at once ("Atalhos ligados").
    pub on: bool,
    /// Say on the big text what a key just did (the page reads it).
    pub announce: bool,
    /// What "esconder/mostrar overlays" hides: "all", "meter" or "keepCalls".
    pub overlays: String,
    /// Each action's key; "" (or missing) is off.
    pub keys: BTreeMap<String, String>,
}

impl Default for Config {
    fn default() -> Self {
        // Only the settings key is on by default: any other key taken from
        // the game without the player asking could break one of its own.
        let mut keys = BTreeMap::new();
        for a in ACTIONS {
            keys.insert(a.to_string(), if a == "open" { OPEN_DEFAULT.to_string() } else { String::new() });
        }
        Config { on: true, announce: true, overlays: "all".into(), keys }
    }
}

impl Config {
    /// Whatever was stored (an older version, a hand edit), back to sane
    /// values: unknown actions dropped, bad keys off, a key used twice kept
    /// only by the first action.
    pub fn clean(mut self) -> Config {
        let mut keys = BTreeMap::new();
        let mut used: Vec<(u32, u32)> = Vec::new();
        for a in ACTIONS {
            let raw = self.keys.get(a).cloned().unwrap_or_else(|| if a == "open" { OPEN_DEFAULT.into() } else { String::new() });
            let label = match parse(&raw) {
                Some(k) if allowed(k.0, k.1) && !used.contains(&k) => {
                    used.push(k);
                    label_of(k.0, k.1)
                }
                _ => String::new(),
            };
            keys.insert(a.to_string(), label);
        }
        self.keys = keys;
        if !["all", "meter", "keepCalls"].contains(&self.overlays.as_str()) {
            self.overlays = "all".into();
        }
        self
    }

    pub fn key(&self, action: &str) -> &str {
        self.keys.get(action).map(|s| s.as_str()).unwrap_or("")
    }
}

/// The windows over the game that "esconder overlays" hides, by the option.
pub fn overlays_hidden_by(option: &str, all: &[&'static str]) -> Vec<&'static str> {
    match option {
        "meter" => all.iter().copied().filter(|l| *l == "meter").collect(),
        // The big text ("overlay") stays: the calls still come.
        "keepCalls" => all.iter().copied().filter(|l| *l != "overlay").collect(),
        _ => all.to_vec(),
    }
}

/// Key names and their virtual-key codes.
const KEYS: &[(&str, u32)] = &[
    ("Backspace", 0x08), ("Tab", 0x09), ("Enter", 0x0D), ("Pause", 0x13), ("Esc", 0x1B), ("Space", 0x20),
    ("PageUp", 0x21), ("PageDown", 0x22), ("End", 0x23), ("Home", 0x24),
    ("Left", 0x25), ("Up", 0x26), ("Right", 0x27), ("Down", 0x28),
    ("Insert", 0x2D), ("Delete", 0x2E),
    ("Num0", 0x60), ("Num1", 0x61), ("Num2", 0x62), ("Num3", 0x63), ("Num4", 0x64),
    ("Num5", 0x65), ("Num6", 0x66), ("Num7", 0x67), ("Num8", 0x68), ("Num9", 0x69),
    ("NumMul", 0x6A), ("NumAdd", 0x6B), ("NumSub", 0x6D), ("NumDecimal", 0x6E), ("NumDiv", 0x6F),
    ("ScrollLock", 0x91),
];

fn vk_of(name: &str) -> Option<u32> {
    let up = name.to_ascii_uppercase();
    if let Some((_, vk)) = KEYS.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
        return Some(*vk);
    }
    match up.as_str() {
        "ESCAPE" => return Some(0x1B),
        "RETURN" => return Some(0x0D),
        "DEL" => return Some(0x2E),
        _ => {}
    }
    if let Some(n) = up.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        return (1..=24).contains(&n).then(|| 0x70 + n - 1);
    }
    let mut c = up.chars();
    match (c.next(), c.next()) {
        (Some(ch), None) if ch.is_ascii_alphanumeric() => Some(ch as u32),
        _ => None,
    }
}

fn name_of(vk: u32) -> Option<String> {
    if let Some((n, _)) = KEYS.iter().find(|(_, v)| *v == vk) {
        return Some(n.to_string());
    }
    match vk {
        0x30..=0x39 | 0x41..=0x5A => Some(char::from_u32(vk)?.to_string()),
        0x70..=0x87 => Some(format!("F{}", vk - 0x70 + 1)),
        _ => None,
    }
}

/// "Ctrl+Alt+R" into (modifiers, virtual-key). None when empty or unknown.
pub fn parse(label: &str) -> Option<(u32, u32)> {
    let label = label.trim();
    if label.is_empty() {
        return None;
    }
    let mut mods = 0;
    let mut vk = None;
    for part in label.split('+') {
        let p = part.trim();
        match p.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "alt" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "win" | "super" => mods |= MOD_WIN,
            _ => {
                // Two keys besides the modifiers is not a key Windows takes.
                if vk.is_some() {
                    return None;
                }
                vk = Some(vk_of(p)?);
            }
        }
    }
    vk.map(|k| (mods, k))
}

/// The one way a key is written (Ctrl, Alt, Shift, then the key).
pub fn label_of(mods: u32, vk: u32) -> String {
    let mut s = String::new();
    for (m, n) in [(MOD_CONTROL, "Ctrl+"), (MOD_ALT, "Alt+"), (MOD_SHIFT, "Shift+"), (MOD_WIN, "Win+")] {
        if mods & m != 0 {
            s.push_str(n);
        }
    }
    s.push_str(&name_of(vk).unwrap_or_default());
    s
}

/// A key the program may take for itself. A global key is taken from every
/// program, so a letter, a number or the space on its own (or with Shift)
/// would stop the player typing in the game's chat; the Windows key belongs
/// to Windows. The page warns about more (ui/hotkeys.js); this is the floor.
pub fn allowed(mods: u32, vk: u32) -> bool {
    if mods & MOD_WIN != 0 {
        return false;
    }
    let typing = matches!(vk, 0x30..=0x39 | 0x41..=0x5A | 0x20 | 0x0D | 0x09 | 0x08 | 0x1B | 0x60..=0x6F);
    if typing && mods & (MOD_CONTROL | MOD_ALT) == 0 {
        return false;
    }
    // Windows' own: Alt+Tab, Alt+F4, Alt+Esc, Ctrl+Esc, Alt+Space, Ctrl+Alt+Del.
    let (ctrl, alt, shift) = (mods & MOD_CONTROL != 0, mods & MOD_ALT != 0, mods & MOD_SHIFT != 0);
    let windows = (alt && !ctrl && (vk == 0x09 || vk == 0x73 || vk == 0x1B || vk == 0x20))
        || (ctrl && !alt && vk == 0x1B)
        || (ctrl && alt && vk == 0x2E)
        || (ctrl && shift && vk == 0x1B);
    !windows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_both_ways() {
        assert_eq!(parse("Alt+E"), Some((MOD_ALT, 'E' as u32)));
        assert_eq!(parse("ctrl+shift+f5"), Some((MOD_CONTROL | MOD_SHIFT, 0x74)));
        assert_eq!(parse("Ctrl+Alt+Num7"), Some((MOD_CONTROL | MOD_ALT, 0x67)));
        assert_eq!(parse("F24"), Some((0, 0x87)));
        assert_eq!(parse("Alt+PageUp"), Some((MOD_ALT, 0x21)));
        assert_eq!(parse("F25"), None);
        assert_eq!(parse("Ctrl+Alt"), None);
        assert_eq!(parse("Alt+E+R"), None);
        assert_eq!(parse(""), None);
        assert_eq!(parse("Alt+Ç"), None);
        for l in ["Alt+E", "Ctrl+Alt+Shift+R", "F9", "Alt+Num0", "Ctrl+Up", "Alt+Shift+1", "Shift+F12", "Ctrl+ScrollLock"] {
            let (m, v) = parse(l).unwrap();
            assert_eq!(label_of(m, v), l);
        }
        // Written in another order, it comes back in the one order.
        let (m, v) = parse("Shift+Alt+r").unwrap();
        assert_eq!(label_of(m, v), "Alt+Shift+R");
    }

    #[test]
    fn keys_that_would_break_typing_or_windows_are_refused() {
        let ok = |l: &str| parse(l).map(|(m, v)| allowed(m, v)).unwrap_or(false);
        assert!(ok("Alt+E"));
        assert!(ok("F9"));
        assert!(ok("Ctrl+Shift+R"));
        assert!(ok("Pause"));
        assert!(!ok("R"));
        assert!(!ok("Shift+R"));
        assert!(!ok("Space"));
        assert!(!ok("Num5"));
        assert!(!ok("Win+R"));
        assert!(!ok("Alt+Tab"));
        assert!(!ok("Alt+F4"));
        assert!(!ok("Ctrl+Esc"));
        assert!(!ok("Ctrl+Alt+Delete"));
        assert!(!ok("Ctrl+Shift+Esc"));
        assert!(!ok("Alt+Space"));
    }

    #[test]
    fn stored_settings_cleaned() {
        let d = Config::default().clean();
        assert_eq!(d.key("open"), "Alt+E");
        assert_eq!(d.key("record"), "");
        assert!(d.on && d.announce);

        let raw: Config = serde_json::from_str(r#"{"keys":{"open":"alt+e","record":"Alt+E","names":"R","test":"ctrl+alt+t","gone":"F1"},"overlays":"x"}"#).unwrap();
        let c = raw.clean();
        assert_eq!(c.key("open"), "Alt+E");
        assert_eq!(c.key("record"), ""); // the same key twice: the first keeps it
        assert_eq!(c.key("names"), ""); // a plain letter
        assert_eq!(c.key("test"), "Ctrl+Alt+T");
        assert_eq!(c.key("overlays"), "");
        assert!(!c.keys.contains_key("gone"));
        assert_eq!(c.overlays, "all");
        assert!(c.on); // missing: the default

        // Turned off on purpose stays off (not back to Alt+E).
        let off: Config = serde_json::from_str(r#"{"keys":{"open":""}}"#).unwrap();
        assert_eq!(off.clean().key("open"), "");
    }

    #[test]
    fn what_hide_overlays_hides() {
        let all = ["overlay", "meter", "boss", "party", "cast"];
        assert_eq!(overlays_hidden_by("all", &all), all.to_vec());
        assert_eq!(overlays_hidden_by("meter", &all), vec!["meter"]);
        assert_eq!(overlays_hidden_by("keepCalls", &all), vec!["meter", "boss", "party", "cast"]);
    }
}
