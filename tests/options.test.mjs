// node tests/options.test.mjs: the general pass's options. How long a call
// stays, how many make a cleanse call, the meter out of a fight, and the
// settings window holding every control the code and the layouts use.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (f) => readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8");
const ctx = { window: {}, globalThis: {} };
vm.createContext(ctx);
for (const f of ["data.js", "logic.js", "partyview.js", "meterview.js"]) vm.runInContext(read(f), ctx);
const { callUntil } = ctx.window.LudraEngine;
const P = ctx.window.LudraParty;
const K = ctx.window.meterKit;

// "Tempo do aviso na tela".
assert.equal(callUntil({ kind: "cast" }, 1000, "normal"), 9000);
assert.equal(callUntil({ kind: "pre" }, 1000, "normal"), 6000);
assert.equal(callUntil({ kind: "cast" }, 1000, "short"), 6000);
assert.equal(callUntil({ kind: "cast" }, 1000, "long"), 13000);
assert.equal(callUntil({ kind: "cast" }, 1000, undefined), 9000); // an old save: as before
assert.equal(callUntil({ kind: "cast", end: 4000 }, 1000, "short"), 5500); // a countdown stays to its end
assert.equal(callUntil({ kind: "cast", end: 500 }, 1000, "long"), 2500);

// "Aviso de limpeza: o mesmo debuff em N ou mais".
const d = (id, name) => ({ id, name, secs_left: 5, stacks: 1, harmful: true, cleansable: true });
const frames = [1, 2].map((i) => ({ name: `p${i}`, debuffs: [d(9, "Veneno")] }));
assert.equal(P.cleanseCalls(frames, 0, new Map()).length, 0); // 3 by default
assert.equal(P.cleanseCalls(frames, 0, new Map(), 8000, 2).length, 1);
assert.equal(P.cleanseCalls(P.DEMO_FRAMES, 0, new Map(), 8000, 4).length, 0);
assert.equal(P.cleanseCalls(P.DEMO_FRAMES, 0, new Map(), 8000, "3").length, 1);
assert.equal(P.cleanseCalls(frames, 0, new Map(), 8000, 0).length, 0); // nonsense: back to 3

// The meter over the game out of a fight ("Fora da luta").
assert.equal(K.idleAlpha("fade", true, false, 0.8), 0.8);
assert.equal(K.idleAlpha("fade", false, false, 0.8), 0.4);
assert.equal(K.idleAlpha("show", false, false, 0.8), 0.8);
assert.equal(K.idleAlpha("hide", false, false, 0.8), 0);
assert.equal(K.idleAlpha("hide", false, true, 0.8), 0.4); // placing the boxes: still there to drag
assert.equal(K.idleAlpha("hide", true, false, 1), 1);

// Every control the code and the layouts read is in the settings window, once.
const html = read("index.html");
const has = (cls) => (html.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`, "g")) || []).length;
const presets = read("presets.js");
const KEYS = [...presets.slice(presets.indexOf("const KEYS"), presets.indexOf("];", presets.indexOf("const KEYS"))).matchAll(/"\.([A-Za-z]+)"/g)].map((m) => m[1]);
assert.ok(KEYS.length > 30);
for (const k of KEYS) assert.equal(has(k), 1, `layout key .${k}`);
for (const k of ["beep", "deathCalls", "staggerCalls", "callHold", "lookReset", "placeReset", "lookResetAll", "resetNote", "fWipes", "fKeep", "fClear", "partyOpacity", "cleanseMin"]) assert.equal(has(k), 1, k);

// "Tamanhos e opacidade padrão": each default is a value its slider can take.
const ed = read("editor.js");
const defs = JSON.parse(ed.match(/LOOK_DEFAULTS = (\{[^}]+\})/)[1].replace(/"\.(\w+)"/g, '"$1"'));
for (const [k, v] of Object.entries(defs)) {
  const m = html.match(new RegExp(`<input type="range" class="${k}" min="(\\d+)" max="(\\d+)" step="(\\d+)"`));
  assert.ok(m, `slider .${k}`);
  const [min, max, step] = m.slice(1).map(Number);
  assert.ok(v >= min && v <= max && (v - min) % step === 0, `.${k} default ${v}`);
}
// The same defaults as the code that reads them.
assert.match(read("plugin.js"), /size: "60",.*bgOpacity: 80/);
assert.match(read("meterctl.js"), /get\("meterOpacity", 85\)/);
assert.match(read("partyctl.js"), /get\("partyOpacity", 80\)/);
console.log("ok options");
