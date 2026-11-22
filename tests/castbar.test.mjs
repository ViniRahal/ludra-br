// node tests/castbar.test.mjs: the boss cast bar. What the engine says the
// boss is casting (name, countdown, target), when a bar ends, and which rows
// the player's options keep; and the countdown the overlay draws.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {}, globalThis: {} };
vm.createContext(ctx);
for (const f of ["data.js", "logic.js"]) vm.runInContext(readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8"), ctx);
const { createEngine, pickBars } = ctx.window.LudraEngine;

let t = 1e6;
let bars = [];
let told = 0;
const calls = [];
const e = createEngine(ctx.window.LUDRA_BR, { now: () => t, call: (c) => calls.push(c), state: () => {}, bars: (b) => ((bars = b), told++) });
const MAX = 500_000_000, LUDRA = 7, OTHER = 99;
e.spawn({ entity: LUDRA, max: MAX, code: 2300290 });
e.hp({ entity: LUDRA, kind: 2, count: 1, res: 0, hp: MAX - 1000 }, t);

// A known mechanic with data.js's own time (Bingo: 15 s), aimed at you.
e.cast({ caster: LUDRA, skill: 1803010, target: 55, target_name: "Dark", target_me: true, ms: 4000 }, t, "cast");
assert.equal(bars.length, 1);
assert.equal(bars[0].title, "BINGO");
assert.equal(bars[0].known, true);
assert.equal(bars[0].end - bars[0].start, 15_000, "data.js secs first");
assert.equal(bars[0].target, "Dark");
assert.equal(bars[0].targetMe, true);
assert.equal(calls.at(-1).text, "BINGO", "the call still comes");

// A known mechanic with no secs: the packet's cast time; its "!" dropped.
t += 100;
e.cast({ caster: LUDRA, skill: 1803370, target: 0, ms: 2500 }, t, "cast");
assert.equal(bars[0].title, "CONE");
assert.equal(bars[0].end - bars[0].start, 2500, "the packet's time");
assert.equal(bars[0].target, "", "no target: none shown");
t += 100;
e.cast({ caster: LUDRA, skill: 1803030, ms: 0 }, t, "cast");
assert.equal(bars[0].title, "CÍRCULOS", "no ! on the bar");

// Neither: the short default. Unknown skill: its name from the meter, marked unknown.
t += 100;
e.cast({ caster: LUDRA, skill: 1803111, skill_name: "Golpe Sombrio", target: LUDRA, target_name: "Ludra" }, t, "cast");
assert.equal(bars.length, 4, "every live cast kept; the page picks the rows");
assert.equal(bars[0].known, false);
assert.equal(bars[0].title, "Golpe Sombrio");
assert.equal(bars[0].end - bars[0].start, 3000);
assert.equal(bars[0].target, "", "aimed at itself: no target");
assert.ok(bars.some((b) => b.title === "BINGO"), "BINGO still running: kept");
t += 100;
e.cast({ caster: LUDRA, skill: 1803112 }, t, "cast");
assert.equal(bars[0].title, "Habilidade 1803112", "no name at all: its id");

// The skill going off (02 38) ends its bar, but not one that came right with its cast.
t += 100;
e.cast({ caster: LUDRA, skill: 1803370, ms: 2500 }, t, "cast");
assert.equal(bars.filter((b) => b.title === "CONE").length, 1, "cast again: one bar, started over");
const cone = bars.find((b) => b.title === "CONE");
assert.ok(cone);
e.cast({ caster: LUDRA, skill: 1803370 }, cone.start + 200, "use");
assert.ok(bars.some((b) => b.title === "CONE"), "02 38 at once: the bar stays");
t = cone.start + 1200;
e.cast({ caster: LUDRA, skill: 1803370 }, t, "use");
assert.ok(!bars.some((b) => b.title === "CONE"), "went off: bar gone");

// Another monster's cast of the same boss's skill while ours is fought (anchored): no bar.
e.hp({ entity: LUDRA, kind: 2, count: 1, res: 0, hp: MAX * 0.8 }, t);
const before = bars.length;
e.spawn({ entity: OTHER, max: MAX, code: 2300282 }); // Rahu
e.cast({ caster: OTHER, skill: 1802900 }, t, "cast");
assert.equal(bars.length, before, "not our boss: nothing");

// An old cast (queued while the window was shut): no bar.
told = 0;
e.cast({ caster: LUDRA, skill: 1803160, ms: 2000 }, t - 10_000, "cast");
assert.equal(told, 0);

// The bars run out by themselves; the tick tells it once.
t += 20_000;
e.hp({ entity: LUDRA, kind: 2, count: 1, res: 0, hp: MAX * 0.7 }, t);
e.tick();
assert.equal(bars.length, 0);
assert.equal(e.castBars().length, 0);

// The boss gone: no bars left.
e.cast({ caster: LUDRA, skill: 1803160, ms: 2000 }, t, "cast");
assert.equal(bars.length, 1);
e.clear();
assert.equal(bars.length, 0);

// A real mechanic, then three skills with no call 0.5 s apart: with unknown
// skills hidden (the default) BINGO must still be on screen.
{
  let tt = 2e6, bb = [];
  const e2 = createEngine(ctx.window.LUDRA_BR, { now: () => tt, call: () => {}, state: () => {}, bars: (b) => (bb = b) });
  e2.spawn({ entity: LUDRA, max: MAX, code: 2300290 });
  e2.hp({ entity: LUDRA, kind: 2, count: 1, res: 0, hp: MAX - 1000 }, tt);
  e2.cast({ caster: LUDRA, skill: 1803010 }, tt, "cast");
  for (const sk of [1803111, 1803112, 1803113]) {
    tt += 500;
    e2.cast({ caster: LUDRA, skill: sk }, tt, "cast");
  }
  assert.equal(bb.length, 4);
  assert.deepEqual([...pickBars(bb, { max: 2, unknown: false }).map((b) => b.title)], ["BINGO"], "unknown skills never push BINGO off");
  assert.equal(pickBars(bb, { max: 2, unknown: true }).length, 2, "unknown on: the two newest");
}

// The player's options: unknown skills only when asked, and how many rows.
const list = [
  { id: "a", known: false },
  { id: "b", known: true },
  { id: "c", known: true },
  { id: "d", known: true },
];
assert.deepEqual([...pickBars(list, { unknown: false, max: "2" }).map((b) => b.id)], ["b", "c"]);
assert.deepEqual([...pickBars(list, { unknown: true, max: 3 }).map((b) => b.id)], ["a", "b", "c"]);
assert.deepEqual(pickBars(list, { unknown: true, max: 9 }).length, 3, "never more than three");
assert.deepEqual([...pickBars(list, { max: "1" }).map((b) => b.id)], ["b"]);
assert.equal(pickBars(null, {}).length, 0);

// The overlay's countdown: the part left and the time in Portuguese.
const view = { window: {}, document: { createElement: () => ({}) } };
vm.createContext(view);
vm.runInContext(readFileSync(new URL("../ui/bossview.js", import.meta.url), "utf8"), view);
const left = view.window.castLeft;
assert.deepEqual({ ...left({ start: 0, end: 10_000 }, 7_500) }, { frac: 0.25, text: "2,5s" });
assert.deepEqual({ ...left({ start: 0, end: 15_000 }, 1_000) }, { frac: 14 / 15, text: "14s" });
assert.deepEqual({ ...left({ start: 0, end: 1_000 }, 5_000) }, { frac: 0, text: "0,0s" });
console.log("ok castbar");
