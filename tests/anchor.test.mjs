// node tests/anchor.test.mjs: the boss being fought keeps the fight (19/11 test run:
// Ludra jumped back to 100% mid-fight, the PT1 boss got the PT2 boss's calls).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {}, globalThis: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../ui/data.js", import.meta.url), "utf8"), ctx);
vm.runInContext(readFileSync(new URL("../ui/logic.js", import.meta.url), "utf8"), ctx);
const DATA = ctx.window.LUDRA_BR, { createEngine } = ctx.window.LudraEngine;
let t = 1e6, st = null;
const calls = [];
const e = createEngine(DATA, { now: () => t, call: (c) => calls.push(c), state: (s) => (st = s), savePrefs: () => {}, saveLog: () => {} });
const hp = (id, v) => e.hp({ entity: id, kind: 2, count: 1, res: 0, hp: v }, t);

// Ludra (Normal) at 80%.
e.spawn({ entity: 10, max: 4e8, code: 2301014 });
for (let p = 99; p >= 80; p--) { t += 1000; hp(10, 4e8 * p / 100); }
assert.equal(st.key, "ludra");
assert.equal(st.diff, "normal");
assert.equal(Math.round(st.pct), 80);
// A copy of Ludra (no boss in the game's table) with full HP casts Ludra's skill.
e.spawn({ entity: 77, max: 4e8, code: 2921505 });
t += 500; hp(77, 4e8);
e.cast({ caster: 77, skill: 1803010 }, t, "cast");
assert.equal(e._boss().id, 10, "the fight stays with Ludra");
assert.equal(Math.round(st.pct), 80, "no jump back to 100%");
assert.ok(calls.some((c) => c.text.startsWith("BOMBAS")), "the copy's mechanic is still Ludra's");
// A big add with no code: nothing changes.
t += 500; hp(555, 9e8);
assert.equal(e._boss().id, 10);

// Rahu (PT1): a Ketu skill from something that is not Ketu here: no Ketu call.
const e2 = createEngine(DATA, { now: () => t, call: (c) => calls.push(c), state: (s) => (st = s) });
e2.spawn({ entity: 20, max: 2e8, code: 2301006 });
for (let p = 99; p >= 70; p -= 5) { t += 1000; e2.hp({ entity: 20, kind: 2, count: 1, res: 0, hp: 2e8 * p / 100 }, t); }
const before = calls.length;
e2.cast({ caster: 4242, skill: 1801962 }, t, "cast");
e2.cast({ caster: 4243, skill: 1801970 }, t, "cast");
assert.equal(e2._boss().key, "rahu");
assert.equal(calls.length, before, "no Ketu calls while on Rahu");
// The meter's target decides too: the reactor (boss 1) by its code.
const e3 = createEngine(DATA, { now: () => t, call: () => {}, state: (s) => (st = s) });
e3.follow({ id: 30, boss: true, code: 2300284, name: "Reator de Fusão Central Abissal", hp: 9e7, max: 1e8 });
assert.equal(st.key, "reator");
assert.equal(st.diff, "hard");
assert.equal(Math.round(st.pct), 90);
console.log("anchor: ok");

// 19/11 registro: Ludra at 44% calls something that casts Ketu's skill 1801951
// over and over (and Ludra copies at full HP). The fight stays on Ludra.
{
  const c4 = [];
  const e4 = createEngine(DATA, { now: () => t, call: (c) => c4.push(c), state: (s) => (st = s) });
  e4.spawn({ entity: 40, max: 4e8, code: 2301014 });
  for (let p = 99; p >= 44; p -= 5) { t += 2000; e4.hp({ entity: 40, kind: 2, count: 1, res: 0, hp: 4e8 * p / 100 }, t); }
  e4.spawn({ entity: 41, max: 3e7, code: 2920671 });
  for (let i = 0; i < 8; i++) {
    t += 1000;
    e4.hp({ entity: 41, kind: 2, count: 1, res: 0, hp: 3e7 }, t);
    e4.cast({ caster: 41, skill: 1801951 }, t, "cast");
    e4.cast({ caster: 4400 + i, skill: 1801951 }, t, "cast");
    e4.spawn({ entity: 50 + i, max: 4e8, code: 2921506 });
    e4.hp({ entity: 50 + i, kind: 2, count: 1, res: 0, hp: 4e8 }, t);
    e4.cast({ caster: 50 + i, skill: 1803395 }, t, "cast");
  }
  assert.equal(st.key, "ludra", "Ketu's skill does not take Ludra's fight");
  assert.equal(e4._boss().id, 40);
  assert.ok(st.pct < 50, "no jump back to 100%");
  console.log("anchor 19/11: ok");
}
