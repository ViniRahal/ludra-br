// node tests/spawn.test.mjs: the spawn's max HP makes the % exact from the first hit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {}, globalThis: {} };
vm.createContext(ctx);
for (const f of ["data.js", "logic.js"]) vm.runInContext(readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8"), ctx);
const DATA = ctx.window.LUDRA_BR, { createEngine } = ctx.window.LudraEngine;
let t = 5_000_000;
const calls = [], states = [];
const e = createEngine(DATA, { now: () => t, call: (c) => calls.push(c), state: (s) => states.push(s) });
const ID = 9001, MAX = 300_000_000;
e.setPrefs({ prewarn: 3, ...{ off: { "ludra:orbes": true, "ludra:arena": true, "ludra:zikel": true }, thresholds: { ludra: { bingo1: 50 } } } });
e.spawn({ entity: ID, max: MAX });
// Joined mid-fight: the first HP seen is 70%, and the % is exact, not ≈100%.
e.hp({ entity: ID, kind: 2, count: 1, res: 0, hp: MAX * 0.7 }, t);
assert.equal(Math.round(e._boss().pct), 70);
assert.equal(e._boss().maxFromPeak, false);
e.cast({ caster: ID, skill: 1803200 }, t, "cast");
assert.equal(e._boss().key, "ludra");
assert.equal(e._boss().max, MAX); // naming it kept the spawn's max
// 52.9%: the pre-warning for Bingo 1 (50%, 3% before)
t += 1000;
e.hp({ entity: ID, kind: 2, count: 1, res: 0, hp: MAX * 0.529 }, t);
assert.ok(calls.some((c) => c.kind === "pre" && /BINGO 1/.test(c.text)), JSON.stringify(calls));
t += 1000;
e.hp({ entity: ID, kind: 2, count: 1, res: 0, hp: MAX * 0.499 }, t);
assert.ok(calls.some((c) => c.kind === "hp" && /BINGO 1/.test(c.text)));
// A spawn seen after the fight started fixes a peak-based max.
const e2 = createEngine(DATA, { now: () => t, call: () => {}, state: () => {} });
e2.hp({ entity: 42, kind: 2, count: 1, res: 0, hp: 150_000_000 }, t);
assert.equal(e2._boss().maxFromPeak, true);
e2.spawn({ entity: 42, max: 200_000_000 });
assert.equal(Math.round(e2._boss().pct), 75);
console.log("ok spawn");
