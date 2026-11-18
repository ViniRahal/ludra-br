// node tests/dungeon.test.mjs: a dungeon boss (far under a raid's HP) is known
// by its spawn's model code, and its HP calls come.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {}, globalThis: {} };
vm.createContext(ctx);
for (const f of ["data.js", "logic.js"]) vm.runInContext(readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8"), ctx);
const DATA = ctx.window.LUDRA_BR, { createEngine } = ctx.window.LudraEngine;
let t = 1_000_000;
const calls = [];
let state = null;
const e = createEngine(DATA, { now: () => t, call: (c) => calls.push(c), state: (s) => (state = s) });
// Bakarma (Draupnir Exploration), 600,000 HP, as its real spawn says.
e.spawn({ entity: 54651, max: 600_000, code: 2_310_471 });
e.hp({ entity: 54651, kind: 2, count: 1, res: 0, hp: 600_000 }, t);
assert.equal(e._boss().key, "bakarma");
assert.equal(state.name, "Bakarma Transcendido (Draupnir)");
t += 1000;
e.hp({ entity: 54651, kind: 2, count: 1, res: 0, hp: 445_000 }, t);
assert.ok(calls.some((c) => c.kind === "hp" && /TELEPORTE/.test(c.text)), JSON.stringify(calls));
// A monster of the same size with no known code is still ignored.
const e2 = createEngine(DATA, { now: () => t, call: () => {}, state: () => {} });
e2.spawn({ entity: 777, max: 600_000, code: 2_999_999 });
e2.hp({ entity: 777, kind: 2, count: 1, res: 0, hp: 600_000 }, t);
assert.equal(e2._boss(), null);
console.log("ok dungeon");
