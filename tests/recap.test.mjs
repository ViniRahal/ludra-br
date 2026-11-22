// node tests/recap.test.mjs: the words of "O que te matou".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../ui/recap.js", import.meta.url), "utf8"), ctx);
const R = ctx.window.LudraRecap;
const r = { name: "Dark", me: true, killer: "Ludra", skill: "Raio em linha", skill_id: 1803290, damage: 85000, window_ms: 2100, taken: 85000,
  hits: [{ before_ms: 1200, from: "Ludra", skill: "Cone", damage: 1_234_000 }, { before_ms: 0, from: "", skill: "", damage: 850 }] };
assert.equal(R.headline(r), "VOCÊ MORREU — Raio em linha (Ludra)");
assert.equal(R.detail(r), "85 mil · em 2,1 s");
assert.deepEqual([...R.lines(r)], ["-1,2 s  Cone (Ludra)  1,2 mi", "-0,0 s  golpe desconhecido  850"]);
assert.equal(R.voice(r), "Você morreu para Raio em linha");
assert.equal(R.headline({ skill: "", killer: "" }), "VOCÊ MORREU — golpe desconhecido");
assert.equal(R.voice({}), "Você morreu");
assert.equal(R.detail({}), "");
assert.equal(R.num(15_000_000), "15 mi");
assert.equal(R.num(1_000_000), "1 mi");
assert.equal(R.short(r), "Raio em linha (85 mil)");
assert.equal(R.summary({ t: 751000, name: "Fulano", mech: "BINGO 1", kill: r }), "12:31 Fulano — Raio em linha (85 mil, 2,1 s) · durante BINGO 1");
assert.equal(R.summary({ t: 751000, name: "Fulano", mech: "RAIO EM LINHA", kill: r }), "12:31 Fulano — Raio em linha (85 mil, 2,1 s)");
assert.equal(R.summary({ t: 5000, name: "Fulano", mech: "ORBES", kill: null }), "0:05 Fulano (ORBES)");
const line = R.logLine(r, Date.UTC(2026, 10, 22, 14, 0, 0));
assert.equal(line.split("\t")[1], "MORTE");
assert.match(line, /Dark \(você\): Raio em linha \(Ludra\)\t1803290\t85000\t2\.1s/);
console.log("ok recap");
