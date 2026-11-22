// node tests/party.test.mjs: the party frames' rules (HP %, group cleanse).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../ui/partyview.js", import.meta.url), "utf8"), ctx);
const P = ctx.window.LudraParty;
assert.equal(P.pctOf({ hp_pct: 42 }), 42);
assert.equal(P.pctOf({ hp: 25, max_hp: 100 }), 25);
assert.equal(P.pctOf({ hp_pct: null, hp: 0, max_hp: 0 }), null);
assert.equal(P.pctOf({ dead: true, hp_pct: 50 }), 0);
const d = (id, name, cleansable, harmful = true) => ({ id, name, secs_left: 5, stacks: 1, harmful, cleansable });
const frames = [
  { name: "A", debuffs: [d(1, "Choque", true)] },
  { name: "B", debuffs: [d(1, "Choque", true), d(2, "Lento", false)] },
  { name: "C", debuffs: [d(1, "Choque", true), d(2, "Lento", false)] },
  { name: "D", debuffs: [d(2, "Lento", false)] },
  { name: "E", dead: true, debuffs: [d(1, "Choque", true)] },
];
// Choque on 3 living (E is dead); Lento can't be cleansed.
assert.equal(JSON.stringify(P.groupDebuffs(frames).map((g) => [g.name, g.n])), JSON.stringify([["Choque", 3]]));
// Unknown cleansable counts when harmful.
assert.equal(P.groupDebuffs([1, 2, 3].map((i) => ({ name: `p${i}`, debuffs: [d(9, "Veneno", null)] })))[0].n, 3);
assert.equal(P.groupDebuffs([1, 2, 3].map((i) => ({ name: `p${i}`, debuffs: [d(9, "Bênção", null, false)] }))).length, 0);
const last = new Map();
const c1 = P.cleanseCalls(frames, 1000, last);
assert.equal(c1.length, 1);
assert.equal(c1[0].text, "LIMPEZA EM GRUPO: Choque em 3");
assert.equal(P.cleanseCalls(frames, 5000, last).length, 0); // within 8 s
assert.equal(P.cleanseCalls(frames, 9001, last).length, 1);
assert.equal(P.inFight({ time_ms: 0, rows: [] }), false);
assert.equal(P.inFight({ time_ms: 3000 }), true);
// The demo party makes a call (Choque on 3).
assert.equal(P.groupDebuffs(P.DEMO_FRAMES)[0].n, 3);
console.log("party ok");
