// node tests/record.test.mjs: the recording's options and rules (ui/reclogic.js).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../ui/reclogic.js", import.meta.url), "utf8"), ctx);
const L = ctx.window.LudraRecLogic;
const plain = (o) => JSON.parse(JSON.stringify(o));

// Defaults, and stored junk back to sane values.
assert.deepEqual(plain(L.clean(null)), plain(L.DEFAULTS));
assert.equal(L.clean({ tail: 1 }).tail, 3);
assert.equal(L.clean({ tail: 99 }).tail, 30);
assert.equal(L.clean({ tail: "12" }).tail, 12);
assert.equal(L.clean({ tail: "x" }).tail, L.DEFAULTS.tail);
assert.equal(L.clean({ bosses: "nope" }).bosses, "ludra");
assert.equal(L.clean({ dir: "  D:\\Zezinho 1  " }).dir, "D:\\Zezinho 1");
assert.equal(L.clean({ dir: 5 }).dir, "");
// The first version's switch carries over.
assert.equal(L.clean({ auto: true }).auto, true);
assert.equal(L.clean({ auto: true }).log, true);

// Which pulls start it.
const fight = (key) => ({ key, pullAt: 1, cur: 100 });
assert.ok(L.isFight(fight("ludra"), "ludra"));
assert.ok(!L.isFight(fight("rahu"), "ludra"));
assert.ok(L.isFight(fight("rahu"), "trio") && L.isFight(fight("ketu"), "trio"));
assert.ok(!L.isFight(fight("reator"), "trio"));
assert.ok(L.isFight(fight("reator"), "all"));
assert.ok(!L.isFight({ key: "ludra", pullAt: 0, cur: 100 }, "ludra"), "not pulled yet");
assert.ok(!L.isFight({ key: "ludra", pullAt: 1, cur: 0 }, "ludra"), "dead");
assert.ok(!L.isFight(null, "all"));

// What goes to the program when it stops.
const t = new Date(2026, 10, 22, 15, 8, 9).getTime();
assert.equal(L.dayName(t), "2026-11-22");
assert.equal(L.stamp(t), "2026-11-22 15-08-09");
const p = L.clean({ dir: "D:\\Zezinho", day: true, log: true });
const a = L.finishArgs(p, t, t + 60000, "linha");
assert.deepEqual(plain(a), { video: null, since: t, until: t + 60000, dir: "D:\\Zezinho", day: "2026-11-22", log: "linha", logName: "Ludra BR registro 2026-11-22 15-08-09.txt" });
assert.equal(L.finishArgs(L.clean({ log: false }), t, t, "linha").log, null, "log off");
assert.equal(L.finishArgs(p, t, t, "x", "D:\\Zezinho\\a.mp4").video, "D:\\Zezinho\\a.mp4", "own recorder's video");
assert.equal(L.clean({}).how, "app", "the program's recorder by default");
assert.equal(L.clean({ how: "x", fps: 45, quality: "?" }).fps, 60);
const sa = L.startArgs(L.clean({ dir: "D:\\V", day: true, fps: 30, quality: "leve", sound: false }), t);
assert.deepEqual(plain(sa), { dir: "D:\\V", day: "2026-11-22", name: "Ludra BR 2026-11-22 15-08-09.mp4", fps: 30, bitrate: 6000000, sound: false });
assert.equal(L.finishArgs(L.clean({}), t, t, "").log, null, "nothing to save");
assert.equal(L.finishArgs(L.clean({}), t, t, "x").day, "", "no day folder");
// "Onde salvar" shows where the video really lands.
assert.equal(L.shownDir(L.clean({}), "C:\\V\\Captures", t), "C:\\V\\Captures (padrão do Windows)");
assert.equal(L.shownDir(L.clean({}), "", t), "Vídeos\\Captures (padrão do Windows)");
assert.equal(L.shownDir(L.clean({ dir: "D:\\Zezinho 1" }), "C:\\V\\Captures", t), "D:\\Zezinho 1");
assert.equal(L.shownDir(L.clean({ dir: "D:\\Zezinho 1\\", day: true }), "", t), "D:\\Zezinho 1\\2026-11-22 (uma pasta por dia)");
assert.equal(L.shownDir(L.clean({ day: true }), "C:\\V\\Captures", t), "C:\\V\\Captures\\2026-11-22 (padrão do Windows, uma pasta por dia)");

// What a finished recording says, even when a new one already started.
const ok = L.describe({ video: "D:\\Zezinho 1\\2026-11-22\\AION2 x.mp4", bytes: 52e6, moved: true, log: "D:\\Zezinho 1\\2026-11-22\\AION2 x - registro da luta.txt" });
assert.equal(ok.line, "Vídeo salvo em D:\\Zezinho 1\\2026-11-22: AION2 x.mp4 (52 MB). O registro da luta foi salvo junto.");
assert.equal(ok.short, "Último vídeo: AION2 x.mp4.");
assert.equal(ok.problem, "");
const stuck = L.describe({ video: "C:\\V\\Captures\\a.mp4", bytes: 1e6, problem: "Não consegui mover o vídeo: disco cheio. Ele ficou em Vídeos\\Captures." });
assert.ok(stuck.short.includes("disco cheio") && stuck.line.includes("disco cheio"), "a problem is always told");
const none = L.describe({ log: "D:\\Z\\Ludra BR registro.txt" });
assert.ok(none.line.startsWith("Não achei o vídeo novo em Vídeos\\Captures."));
assert.ok(none.line.includes("salvo em D:\\Z"));
assert.ok(none.problem);
assert.ok(L.describe(null).problem, "the call itself failed");
assert.ok(!/os error/.test(stuck.line));

console.log("ok record");
