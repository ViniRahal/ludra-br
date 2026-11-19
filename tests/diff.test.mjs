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
const fight = (id, max) => { t += 100000; e.hp({ entity: 1e6 + id, kind: 2, count: 1, res: 0, hp: 0 }, t); e.spawn({ entity: id, max, code: 2301014 }); e.hp({ entity: id, kind: 2, count: 1, res: 0, hp: max * 0.99 }, t); };
// The game's codes first: 2300xxx is Hard.
e.spawn({ entity: 9, max: 5e8, code: 2300290 }); e.hp({ entity: 9, kind: 2, count: 1, res: 0, hp: 4.9e8 }, t);
assert.equal(st.diff, "hard");
e.spawn({ entity: 8, max: 3e8, code: 2301014 }); e.hp({ entity: 8, kind: 2, count: 1, res: 0, hp: 2.9e8 }, t + 100000);
// Then, with no codes, by the sizes seen.
const keep = [DATA.bosses.ludra.normalCodes, DATA.bosses.ludra.hardCodes];
delete DATA.bosses.ludra.normalCodes; delete DATA.bosses.ludra.hardCodes;
t += 200000;
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
