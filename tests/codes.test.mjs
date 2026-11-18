// node tests/dungeon.test.mjs: a boss known by its spawn's model code is named
// at once (Ludra Normal, 2301014); an unknown code under a boss's HP is not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {}, globalThis: {} };
vm.createContext(ctx);
for (const f of ["data.js", "logic.js"]) vm.runInContext(readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8"), ctx);
const DATA = ctx.window.LUDRA_BR, { createEngine } = ctx.window.LudraEngine;
let t = 1_000_000;
let state = null;
const e = createEngine(DATA, { now: () => t, call: () => {}, state: (s) => (state = s) });
e.spawn({ entity: 5000, max: 194_500_000, code: 2_301_014 });
e.hp({ entity: 5000, kind: 2, count: 1, res: 0, hp: 194_500_000 }, t);
assert.equal(e._boss().key, "ludra");
assert.equal(state.name, "Ludra da Eternidade");
const e2 = createEngine(DATA, { now: () => t, call: () => {}, state: () => {} });
e2.spawn({ entity: 777, max: 600_000, code: 2_999_999 });
e2.hp({ entity: 777, kind: 2, count: 1, res: 0, hp: 600_000 }, t);
assert.equal(e2._boss(), null);
console.log("ok codes");
