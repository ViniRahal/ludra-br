// node tests/history.test.mjs: the Histórico's words and chart lines.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../ui/recap.js", import.meta.url), "utf8"), ctx);
vm.runInContext(readFileSync(new URL("../ui/history.js", import.meta.url), "utf8"), ctx);
const H = ctx.window.LudraHistory;
assert.equal(H.result({ won: true }), "Vitória");
assert.equal(H.result({ won: false, low_pct: 43.52 }), "Wipe (até 43,5%)");
assert.equal(H.dur(169000), "2:49");
assert.equal(H.bestCall({ boss: "Ludra", dps: 92000, previous: 85000 }).text, "NOVO RECORDE! 92 mil DPS no Ludra (antes 85 mil)");
assert.equal(H.bestCall({ boss: "Ludra", dps: 92000, previous: 0 }).text, "NOVO RECORDE! 92 mil DPS no Ludra");
const s = H.series([
  { t_ms: 0, boss_pct: 100, dps: [["A", 10], ["B", 5]] },
  { t_ms: 5000, boss_pct: 90, dps: [["A", 30], ["B", 7]] },
]);
assert.equal(s.players.length, 2);
assert.equal(JSON.stringify(s.players[0].pts), JSON.stringify([[0, 10], [5000, 30]]));
assert.equal(s.boss.length, 2);
assert.equal(s.t1, 5000);
assert.equal(s.top, 30);
assert.equal(H.series(null).players.length, 0);
assert.equal(H.niceTop(83000), 100000);
assert.equal(H.niceTop(120000), 150000);
assert.equal(H.niceTop(0), 1000);
assert.equal(JSON.stringify(H.bossesOf([{ boss: "X" }, { boss: "Y" }, { boss: "X" }])), JSON.stringify(["X", "Y"]));
assert.ok(H.demoGet(H.DEMO[0].id).timeline.length > 10);
console.log("history ok");
