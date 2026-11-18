// node tests/diff.test.mjs: Normal or Hard, from the max HPs seen.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {}, globalThis: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../ui/data.js", import.meta.url), "utf8"), ctx);
vm.runInContext(readFileSync(new URL("../ui/logic.js", import.meta.url), "utf8"), ctx);
const DATA = ctx.window.LUDRA_BR, { createEngine } = ctx.window.LudraEngine;
let t = 1e6, st = null;
const e = createEngine(DATA, { now: () => t, call: () => {}, state: (s) => (st = s), savePrefs: () => {}, saveLog: () => {} });
const fight = (id, max) => { e.spawn({ entity: id, max, code: 2301014 }); e.hp({ entity: id, kind: 2, count: 1, res: 0, hp: max * 0.99 }, t); };
e.setPrefs({ maxHp: {}, sizes: {} });
fight(1, 300e6);
assert.equal(st.diff, null, "one size seen: not known");

fight(2, 450e6);
assert.equal(st.diff, "hard");
fight(3, 300e6);
assert.equal(st.diff, "normal");
// data.js codes win
DATA.bosses.ludra.hardCodes = [2301014];
fight(4, 300e6);
assert.equal(st.diff, "hard");
delete DATA.bosses.ludra.hardCodes;
console.log("diff: ok");
