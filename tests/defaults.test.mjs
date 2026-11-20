// node tests/defaults.test.mjs: with the shipped numbers, a Ludra fight from
// 100% to 5% calls every HP mechanic once, in order, each warned 3% before.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {}, globalThis: {} };
vm.createContext(ctx);
for (const f of ["data.js", "logic.js"]) vm.runInContext(readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8"), ctx);
const { createEngine } = ctx.window.LudraEngine;
let t = 1e6;
const calls = [];
const e = createEngine(ctx.window.LUDRA_BR, { now: () => t, call: (c) => calls.push(c), state: () => {} });
const MAX = 500_000_000, ID = 7;
e.spawn({ entity: ID, max: MAX });
e.hp({ entity: ID, kind: 2, count: 1, res: 0, hp: MAX }, t);
e.cast({ caster: ID, skill: 1803200 }, t, "use");
for (let p = 99.5; p >= 5; p -= 0.5) {
  t += 500;
  e.hp({ entity: ID, kind: 2, count: 1, res: 0, hp: Math.round((MAX * p) / 100) }, t);
}
const hp = calls.filter((c) => c.kind === "hp").map((c) => c.text);
assert.deepEqual(hp, ["50% — BINGO 1", "33% — CORES", "25% — BINGO 2", "10% — CÍRCULOS"]);
assert.equal(calls.filter((c) => c.kind === "pre").length, 4);
console.log("ok defaults", hp.length);
