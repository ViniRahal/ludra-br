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

// ---- "Linha do tempo" ----
const O = H.cleanOpts;
assert.equal(JSON.stringify(O(null)), JSON.stringify(H.OPTS_DEFAULTS));
assert.equal(O({ keep: 7, speed: 3, timeline: "x" }).keep, 300, "a number not offered is the default");
assert.equal(O({ keep: "100", speed: 10, timeline: false }).keep, 100);
assert.equal(O({ timeline: false }).timeline, false);
assert.equal(O({ speed: 10 }).speed, 10);
// Old fights (saved before it) have nothing to play.
assert.equal(H.hasReplay({ id: 1, timeline: [] }), false);
assert.equal(H.hasReplay({ hp: [[0, 100], [1000, 99]] }), true);
assert.equal(H.hasReplay({ deaths: [{ t_ms: 1, name: "A" }] }), true);
// HP between two points: a straight line; outside, the end values.
const hp = [[0, 100], [10000, 80], [20000, 80], [30000, 50]];
assert.equal(H.hpAt(hp, 5000), 90);
assert.equal(H.hpAt(hp, 15000), 80);
assert.equal(H.hpAt(hp, 25000), 65);
assert.equal(H.hpAt(hp, -5), 100);
assert.equal(H.hpAt(hp, 99999), 50);
assert.equal(H.hpAt([], 5), null);
assert.equal(H.replayEnd({ duration_ms: 20000, hp }), 30000);
// The page's calls kept with a fight: its boss only, in its time, no unknown
// skills, a cast and its hit (same title within 2 s) once, Bingo told apart.
const bosses = { ludra: { codes: [2301014, 2300290] }, rahu: { codes: [2301006] } };
const fight = { id: 1_000_000, code: 2301014, duration_ms: 60_000 };
const log = [
  { at: 990_000, boss: "ludra", what: { title: "Zona do Trovão" }, pct: 100 }, // before the pull
  { at: 1_005_000, boss: "ludra", what: { title: "Zona do Trovão" }, pct: 97.5 },
  { at: 1_006_000, boss: "ludra", what: { title: "Zona do Trovão" }, pct: 97.4 }, // the same, 1 s on
  { at: 1_010_000, boss: "rahu", what: { title: "Corte" }, pct: 50 }, // another boss
  { at: 1_020_000, boss: "ludra", what: { title: "skill 1803999" }, pct: 80 }, // unknown
  { at: 1_030_000, boss: "ludra", what: { title: "BINGO!", skill: 1803010, n: 2 }, pct: 60.2 },
  { at: 1_070_000, boss: "ludra", what: { title: "Provação" }, pct: 0 }, // after the end + 3 s
  { at: 1_040_000, boss: "ludra", what: null },
];
const cm = H.collectMarks(log, fight, bosses);
assert.equal(JSON.stringify(cm), JSON.stringify([
  { t_ms: 5000, kind: "mech", title: "Zona do Trovão", pct: 97.5 },
  { t_ms: 30000, kind: "bingo", title: "BINGO 2", pct: 60.2 },
]));
assert.equal(H.collectMarks(log, { ...fight, code: 123 }, bosses).length, 0, "a boss with no mechanics in data.js");
assert.equal(H.collectMarks(null, null, bosses).length, 0);
// Markers in time order, deaths with the boss's HP from the line.
const f = {
  id: 1, duration_ms: 30000, hp,
  players: [{ name: "A", class: "templar" }, { name: "B", class: "cleric" }, { name: "C", class: "ranger" }],
  deaths: [
    { t_ms: 12000, name: "B", class: "cleric", killer: "Ludra", skill: "Raio", damage: 85000 },
    { t_ms: 15000, name: "C", killer: "", skill: "" },
  ],
  marks: [
    { t_ms: 25000, kind: "bingo", title: "Bingo", pct: 65 },
    { t_ms: 5000, kind: "mech", title: "Zona", pct: 90 },
    { t_ms: 9000, kind: "stagger", title: "Stagger quebrado", pct: 82 },
    { t_ms: 20000, kind: "revive", title: "B", pct: null },
  ],
  timeline: [
    { t_ms: 15000, dps: [["C", 0]] },
    { t_ms: 20000, dps: [["C", 0]] },
    { t_ms: 25000, dps: [["C", 3000]] },
  ],
};
const ms = H.marksOf(f);
assert.equal(ms.map((m) => `${m.kind}@${m.t}`).join(","), "mech@5000,stagger@9000,death@12000,death@15000,revive@20000,bingo@25000");
assert.equal(ms[2].pct, 80);
assert.equal(H.lastMech(ms, 4000), null);
assert.equal(H.lastMech(ms, 24000).title, "Zona");
assert.equal(H.lastMech(ms, 26000).title, "Bingo");
// Who was up: B down from 12 s to the revive at 20 s; C (no revive seen)
// until damage shows again on the DPS line (the 25 s point: up by 20 s).
const at = (t) => JSON.stringify(H.aliveAt(f, t));
assert.equal(at(11000), JSON.stringify({ alive: ["A", "B", "C"], dead: [] }));
assert.equal(at(13000), JSON.stringify({ alive: ["A", "C"], dead: ["B"] }));
assert.equal(at(16000), JSON.stringify({ alive: ["A"], dead: ["B", "C"] }));
assert.equal(at(21000), JSON.stringify({ alive: ["A", "B", "C"], dead: [] }));
// A death with no way back seen stays down to the end.
assert.equal(JSON.stringify(H.aliveAt({ players: [{ name: "A" }], deaths: [{ t_ms: 1000, name: "A" }] }, 99999).dead), JSON.stringify(["A"]));
// The mouse: the marker nearest, of the kinds shown.
assert.equal(H.nearestMark(ms, 11500, 1000).kind, "death");
assert.equal(H.nearestMark(ms, 11500, 1000, ["mech"]), null);
assert.equal(JSON.stringify(H.shownKinds({ ...H.OPTS_DEFAULTS, showDeaths: false, showRevive: false })), JSON.stringify(["mech", "bingo", "stagger"]));
// The words.
const dt = H.markText(ms[2]);
assert.equal(dt.head, "0:12 · ☠ B morreu");
assert.equal(dt.body, "Golpe que matou: Raio (Ludra), 85 mil\nVida do boss: 80%");
assert.match(H.markText(ms[3]).body, /Não deu para ver/);
assert.equal(H.markText(ms[5]).head, "0:25 · 🎯 Bingo");
assert.equal(H.markText(ms[4]).head, "0:20 · ✚ B voltou");
// "Esconder nomes": the names drawn hidden, the fight keeps the real ones.
const hide = Object.assign((n) => (n === "B" ? "Jogador 2" : n), { text: (n) => (n === "Ludra" ? "Ludra" : "?") });
assert.equal(H.markText(ms[2], hide).head, "0:12 · ☠ Jogador 2 morreu");
// The demo plays; its third fight is an "old" one.
assert.ok(H.hasReplay(H.demoGet(H.DEMO[0].id)));
assert.ok(!H.hasReplay(H.demoGet(H.DEMO[2].id)));

// A smaller "Quantas lutas guardar": how many fights the next save deletes
// (the records' fights stay, like Store::save).
{
  const L = (n, bests = []) => Array.from({ length: n }, (_, i) => ({ id: n - i, best: bests.includes(n - i) }));
  assert.equal(H.keepLoss(L(40), 50), 0);
  assert.equal(H.keepLoss(L(50), 50), 0);
  assert.equal(H.keepLoss(L(120), 50), 70);
  assert.equal(H.keepLoss(L(52, [1, 2]), 50), 2, "the two oldest are records: but 50 others stay");
  assert.equal(H.keepLoss(L(53, [1]), 50), 3);
  assert.equal(H.keepLoss(L(3, [1, 2, 3]), 1), 0, "only records: nothing goes");
  assert.equal(H.keepLoss(null, 50), 0);
}
console.log("history ok");
