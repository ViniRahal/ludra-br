// node tests/hotkeys.test.mjs: the keys' options and rules (ui/hotkeys.js).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../ui/hotkeys.js", import.meta.url), "utf8"), ctx);
const H = ctx.window.LudraHotkeys;
const plain = (o) => JSON.parse(JSON.stringify(o));

// Defaults: only the settings key, Alt+E as always.
assert.deepEqual(plain(H.clean(null)), plain(H.DEFAULTS));
assert.equal(H.clean({}).keys.open, "Alt+E");
assert.equal(H.clean({}).keys.record, "");
// Turned off on purpose stays off.
assert.equal(H.clean({ keys: { open: "" } }).keys.open, "");
// Junk back to sane values; one key, one action (the first keeps it).
{
  const c = H.clean({ on: "yes", overlays: "x", keys: { open: "alt+e", record: "Alt+E", names: "R", test: "shift+alt+t", nope: "F1" } });
  assert.equal(c.on, true);
  assert.equal(c.overlays, "all");
  assert.equal(c.keys.open, "Alt+E");
  assert.equal(c.keys.record, "");
  assert.equal(c.keys.names, "");
  assert.equal(c.keys.test, "Alt+Shift+T");
  assert.equal("nope" in c.keys, false);
}

// Names: written one way, whatever order or case.
assert.equal(H.normal("shift+ctrl+f5"), "Ctrl+Shift+F5");
assert.equal(H.normal("Alt+space"), "Alt+Space");
assert.equal(H.normal("Ctrl+Alt+num7"), "Ctrl+Alt+Num7");
assert.equal(H.normal("Alt+E+R"), "");
assert.equal(H.normal("Ctrl+Alt"), "");
assert.equal(H.normal("F25"), "");
assert.equal(H.display("Ctrl+Alt+Space"), "Ctrl + Alt + Espaço");
assert.equal(H.display("Alt+Num5"), "Alt + Num 5");

// A key press while waiting for one.
const ev = (code, m = {}) => ({ code, key: m.key || code, ctrlKey: !!m.ctrl, altKey: !!m.alt, shiftKey: !!m.shift, metaKey: !!m.meta });
assert.equal(H.fromEvent(ev("KeyR", { alt: true, shift: true })).label, "Alt+Shift+R");
assert.equal(H.fromEvent(ev("Digit3", { ctrl: true })).label, "Ctrl+3");
assert.equal(H.fromEvent(ev("F9")).label, "F9");
assert.equal(H.fromEvent(ev("Numpad4", { alt: true })).label, "Alt+Num4");
assert.equal(H.fromEvent(ev("AltLeft", { alt: true, key: "Alt" })).partial, "Alt+…");
assert.equal(H.fromEvent(ev("ControlLeft", { key: "Control" })).partial, "");
assert.equal(H.fromEvent(ev("Escape", { key: "Escape" })).cancel, true);
assert.equal(H.fromEvent(ev("Escape", { ctrl: true, shift: true, key: "Escape" })).label, "Ctrl+Shift+Esc");
assert.ok(H.fromEvent(ev("KeyR", { meta: true })).error);
assert.ok(H.fromEvent(ev("Semicolon", { alt: true, key: "ç" })).error); // ABNT2's Ç: not a key we name
// Letters by their place: the Brazilian layout gives the same name.
assert.equal(H.keyName("KeyQ"), "Q");

// Keys that can't be used.
const keys = { open: "Alt+E", record: "Alt+Shift+R" };
for (const bad of ["R", "Shift+R", "Space", "Num5", "Enter", "Alt+Tab", "Alt+F4", "Ctrl+Esc", "Ctrl+Shift+Esc", "Ctrl+Alt+Delete", "Alt+Space", "Ctrl+C", "Ctrl+V", "Ctrl+Alt+Q", "Win+R"]) {
  assert.equal(H.check(bad, keys, "names").level, "block", bad);
}
// Usable, with a word of caution.
for (const w of ["F9", "Alt+Enter", "Ctrl+Alt+E", "Alt+3", "Pause"]) {
  assert.equal(H.check(w, keys, "names").level, "warn", w);
}
// Fine.
const ok = H.check("Alt+Shift+N", keys, "names");
assert.equal(ok.level, null);
assert.equal(ok.label, "Alt+Shift+N");
assert.equal(ok.other, null);
// Another action's key: it moves here, the other is left off.
const taken = H.check("alt+shift+r", keys, "names");
assert.equal(taken.other, "record");
assert.match(taken.moved, /Gravar/);
assert.equal(H.check("Alt+Shift+R", keys, "record").other, null); // its own key
{
  const p = H.assign(H.clean({ keys }), "names", "alt+shift+r");
  assert.equal(p.keys.names, "Alt+Shift+R");
  assert.equal(p.keys.record, "");
  assert.equal(p.keys.open, "Alt+E");
}

// "Ligar": the suggestion, unless another action has it.
assert.equal(H.suggestion(H.clean(null), "record"), "Alt+Shift+R");
assert.equal(H.suggestion(H.clean({ keys: { open: "Alt+E", test: "Alt+Shift+R" } }), "record"), "");
// Every suggestion is a usable key, and no two are the same.
const sug = H.ACTIONS.map((a) => a.suggest);
assert.equal(new Set(sug).size, sug.length);
for (const s of sug) assert.notEqual(H.check(s, {}, "x").level, "block", s);

// The line under an action, from what Windows said.
assert.equal(H.statusLine("Alt+E", { key: "Alt+E", state: "ok" }, true), "");
assert.match(H.statusLine("Alt+E", { key: "Alt+Shift+E", state: "ok" }, true), /Alt \+ Shift \+ E/);
assert.match(H.statusLine("Alt+Shift+R", { key: "Alt+Shift+R", state: "taken" }, true), /Outro programa/);
assert.equal(H.statusLine("Alt+Shift+R", { state: "taken" }, false), ""); // all off: nothing to say
assert.equal(H.statusLine("", { state: "off" }, true), "");

// The same actions, in the same order, as src/hotkeys.rs (its ids).
const rs = readFileSync(new URL("../src/hotkeys.rs", import.meta.url), "utf8");
const m = /pub const ACTIONS: \[&str; \d+\] = \[([^\]]+)\]/.exec(rs);
assert.deepEqual(m[1].split(",").map((x) => x.trim().replace(/"/g, "")), plain(H.ACTIONS.map((a) => a.id)));

console.log("hotkeys ok");

// Alt+E taken by another program: no claim about which one it is.
{
  const line = H.statusLine("Alt+E", { key: "Alt+Shift+E", state: "ok" }, true);
  assert.equal(line, "Outro programa já usa Alt + E (o Questlog, por exemplo). Por isso está em Alt + Shift + E.");
  assert.equal(H.statusLine("Alt+E", { key: "Alt+E", state: "ok" }, true), "");
  assert.equal(H.statusLine("Alt+E", { key: "Alt+Shift+E", state: "ok" }, false), "");
}
