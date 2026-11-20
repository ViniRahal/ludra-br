// node tests/upcoming.test.mjs: the next mechanic by time, learned from the log.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {}, globalThis: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../ui/data.js", import.meta.url), "utf8"), ctx);
vm.runInContext(readFileSync(new URL("../ui/logic.js", import.meta.url), "utf8"), ctx);
const DATA = ctx.window.LUDRA_BR, { createEngine } = ctx.window.LudraEngine;

let t = 5_000_000;
const calls = [];
let st = null;
const e = createEngine(DATA, { now: () => t, call: (c) => calls.push(c), state: (s) => (st = s), saveLog: () => {} });
e.setPrefs({ prewarn: 3 });
const MAX = 400_000_000;
// Three past fights: bombs 20 s after the pull, then every 40 s.
let id = 100;
for (let f = 0; f < 3; f++) {
  id++;
  e.spawn({ entity: id, max: MAX, code: 2301014 });
  e.hp({ entity: id, kind: 2, count: 1, res: 0, hp: MAX * 0.999 }, t); // the pull
  const p0 = t;
  for (const s of [20, 60, 100]) {
    t = p0 + s * 1000;
    e.cast({ caster: id, skill: 1803010 }, t, "cast");
  }
  t += 200_000;
  e.hp({ entity: id, kind: 2, count: 1, res: 0, hp: 0 }, t); // dead
}
const log = e.getLog().filter((x) => x.what.skill === 1803010);
assert.equal(log.length, 9);
assert.equal(log[0].since, 20_000);
// A new fight: at the pull, the bombs are due in 20 s.
id++;
e.spawn({ entity: id, max: MAX, code: 2301014 });
e.hp({ entity: id, kind: 2, count: 1, res: 0, hp: MAX * 0.999 }, t);
const pull = t;
assert.ok(st.upcoming, "due by time");
assert.equal(st.upcoming.at, pull + 20_000);
assert.match(st.upcoming.title, /BINGO/);
// 4 s before: a spoken warning, once.
t = pull + 16_000; e.tick(); e.tick();
assert.equal(calls.filter((c) => c.text.startsWith("Em breve: BINGO")).length, 1);
// They come: next one in 40 s.
t = pull + 20_000;
e.cast({ caster: id, skill: 1803010 }, t, "cast");
assert.equal(st.upcoming.at, pull + 60_000);
// A boss with nothing learned: nothing due.
const e2 = createEngine(DATA, { now: () => t, call: () => {}, state: (s) => (st = s) });
e2.spawn({ entity: 9, max: MAX, code: 2301006 });
e2.hp({ entity: 9, kind: 2, count: 1, res: 0, hp: MAX * 0.999 }, t);
assert.equal(st.upcoming, null);
console.log("upcoming: ok");
