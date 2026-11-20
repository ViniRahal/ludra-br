// node tests/logic.test.mjs  (from app-ludra/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {}, globalThis: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../ui/data.js", import.meta.url), "utf8"), ctx);
vm.runInContext(readFileSync(new URL("../ui/logic.js", import.meta.url), "utf8"), ctx);
const DATA = ctx.window.LUDRA_BR, { createEngine } = ctx.window.LudraEngine;

let t = 1_000_000;
const calls = [], states = [];
let saved = null;
const e = createEngine(DATA, { now: () => t, call: (c) => calls.push(c), state: (s) => states.push(s), savePrefs: (p) => (saved = p), saveLog: () => {} });
// Written for Bingo 1 at 50% and no 90/85/45% calls: kept that way here.
const OLD = { off: { "ludra:orbes": true, "ludra:arena": true, "ludra:zikel": true }, thresholds: { ludra: { bingo1: 50 } } };
e.setPrefs(OLD);
const MAX = 400_000_000, LUDRA = 7777, ADD = 123, PLAYER = 55;
const hp = (id, v, kind = 2) => e.hp({ entity: id, kind, count: 1, res: 0, hp: v }, t);

// a player and a small add: ignored
hp(PLAYER, 50_000, 1); hp(ADD, 80_000);
assert.equal(e._boss(), null);
// Ludra at the pull, then a cast names it
hp(LUDRA, MAX - 1_000_000);
assert.equal(e._boss().key, null);
e.cast({ caster: LUDRA, skill: 1803200 }, t, "use");
assert.equal(e._boss().key, "ludra");
assert.equal(calls.at(-1).text, "ORBES");
// the same skill as 02 38 right after: not called twice
e.cast({ caster: LUDRA, skill: 1803200 }, t + 100, "use");
assert.equal(calls.filter((c) => c.text === "ORBES").length, 1);
// unrelated skill: dropped
e.cast({ caster: 999, skill: 1234567 }, t);
// a record that is not one HP entry (two entries, FP, a high word): dropped
e.hp({ entity: LUDRA, kind: 2, count: 2, res: 0, hp: 1 }, t);
e.hp({ entity: LUDRA, kind: 2, count: 1, res: 6, hp: 1 }, t);
e.hp({ entity: LUDRA, kind: 2, count: 1, res: 0, hp: 2 ** 40 }, t);
assert.equal(e._boss().cur, MAX - 1_000_000);
// Ludra's circles cast by an effect entity with no HP: the fight stays with Ludra
e.cast({ caster: 4242, skill: 1803030 }, t, "cast");
assert.equal(e._boss().id, LUDRA);
// a player with Ketu's buff id: not taken for a boss
e.buff({ entity: PLAYER, abnormal: 18019631 }, t);
assert.equal(e._boss().id, LUDRA);
// Talisra of the Void's 1801780 is not Ketu's
e.cast({ caster: LUDRA, skill: 1801780 }, t, "cast");
assert.equal(e._boss().key, "ludra");
// down to 53%: pre-warning for Bingo 1 (50%)
for (let p = 99; p >= 52; p--) { t += 1000; hp(LUDRA, MAX * p / 100); }
assert.ok(calls.some((c) => c.kind === "pre" && c.text.includes("BINGO 1")), "prewarn");
t += 1000; hp(LUDRA, MAX * 0.497);
assert.ok(calls.some((c) => c.kind === "hp" && c.text.startsWith("50% — BINGO 1")), "bingo1 at 50");
// max saved once under 50%
assert.ok(saved && saved.maxHp.ludra && saved.maxHp.ludra.length === 1);
// the real Bingo cast at 49.9%: logged with its HP
t += 500; e.cast({ caster: LUDRA, skill: 1803010 }, t, "cast");
assert.equal(calls.at(-1).text, "BINGO");
assert.equal(e.getLog().at(-1).pct, 49.8);
// its 02 38 when the 15 s bar ends: the same cast, not a second Bingo
const nb = calls.length, nl = e.getLog().length;
e.cast({ caster: LUDRA, skill: 1803010 }, t + 15_000, "use");
assert.equal(calls.length, nb); assert.equal(e.getLog().length, nl);
// jump to 20%: only the lowest missed threshold is called (Bingo 2), Cores skipped silently
const before = calls.length;
t += 1000; hp(LUDRA, MAX * 0.2);
const fresh = calls.slice(before).filter((c) => c.kind === "hp");
assert.equal(fresh.length, 1); assert.ok(fresh[0].text.includes("BINGO 2"));
// Bingo 2 is its own skill (1803040, seen at 24% on 20/11)
t += 20_000; e.cast({ caster: LUDRA, skill: 1803040 }, t, "cast");
assert.equal(e.getLog().at(-1).what.skill, 1803040);
// stale event (queued 10 s ago): logged, not called
const c0 = calls.length; e.cast({ caster: LUDRA, skill: 1803030 }, t - 10_000);
assert.equal(calls.length, c0);
// wipe: back to full resets the fight
t += 1000; hp(LUDRA, MAX);
t += 1000; hp(LUDRA, MAX * 0.97);
assert.equal(e._boss().fired.size, 0);
// learning: Bingo 1 seen at 49.9 -> 50, Bingo 2 at 20 -> 20
const learnt = e.learnThresholds();
assert.equal(learnt.ludra.bingo1, 50); assert.equal(learnt.ludra.bingo2, 20.5);
// next fight uses the saved max: first reading 90% of max shows 90%, not 100%
const e2 = createEngine(DATA, { now: () => t, call: () => {}, state: (s) => states.push(s) });
e2.setPrefs({ maxHp: saved.maxHp });
e2.cast({ caster: 42, skill: 1803010 }, t, "use");
e2.hp({ entity: 42, kind: 2, count: 1, res: 0, hp: MAX * 0.9 }, t);
assert.ok(Math.abs(e2._boss().pct - 90) < 0.01, "saved max used: " + e2._boss().pct);
// Ketu buff call
const e3 = createEngine(DATA, { now: () => t, call: (c) => calls.push(c) });
e3.hp({ entity: 9, kind: 2, count: 1, res: 0, hp: 90_000_000 }, t);
e3.buff({ entity: 9, abnormal: 18019631 }, t);
assert.equal(e3._boss().key, "ketu");
assert.equal(calls.at(-1).text, "ESCONDE-ESCONDE");
// a monster never named keeps no max HP under "null"
let saved4 = null;
const e4 = createEngine(DATA, { now: () => t, call: () => {}, savePrefs: (p) => (saved4 = p) });
for (let p = 100; p >= 0; p -= 10) e4.hp({ entity: 77, kind: 2, count: 1, res: 0, hp: 60_000_000 * p / 100 }, t);
assert.equal(saved4, null);
// a player's HP (under a boss's size) is never kept
e4.hp({ entity: 78, kind: 2, count: 1, res: 0, hp: 40_000 }, t);
assert.notEqual(e4._boss()?.id, 78);
console.log("ok", calls.length, "calls");
