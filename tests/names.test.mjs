// node tests/names.test.mjs: "Esconder nomes", the names drawn on screen.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../ui/names.js", import.meta.url), "utf8");
function load(storage = new Map()) {
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
  };
  const ctx = { window: { localStorage } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { N: ctx.window.LudraNames, storage };
}

const view = (rows, extra = {}) => ({
  me: { name: "Eu", class: "cleric" },
  me_id: 10,
  party: [
    { name: "Mad", class: "templar", me: false },
    { name: "Eu", class: "cleric", me: true },
    { name: "Zé", class: "templar", me: false },
  ],
  frames: [],
  time_ms: 5000,
  rows,
  ...extra,
});
const row = (id, name, cls, me = false) => ({ id, name, class: cls, me, dps: 1, total: 1 });

// Off (the default): the real names.
{
  const { N } = load();
  assert.equal(N.prefs.on, false);
  assert.equal(N.prefs.keepMe, true);
  N.seed(view([row(3, "Mad", "templar")]));
  assert.equal(N.name("Mad", { cls: "templar" }), "Mad");
  assert.equal(N.text("Mad"), "Mad");
}

// On: the party first in the game's order, then the others by id; you keep
// your name by default; the numbers do not move during the fight.
{
  const { N, storage } = load();
  N.set({ on: true });
  assert.equal(JSON.parse(storage.get("ludra:hideNames")).on, true, "saved");
  const rows = [row(50, "Fora", "ranger"), row(3, "Mad", "templar"), row(10, "Eu", "cleric", true)];
  const before = JSON.stringify(rows);
  N.seed(view(rows));
  // You take no number: with your name shown the others read 1, 2, 3.
  assert.equal(N.name("Mad", { cls: "templar", id: 3 }), "Jogador 1");
  assert.equal(N.name("Eu", { me: true }), "Eu");
  assert.equal(N.name("Zé", {}), "Jogador 2");
  assert.equal(N.name("Fora", { id: 50 }), "Jogador 3");
  assert.equal(JSON.stringify(rows), before, "the data keeps the real names");
  // A newcomer mid-fight gets the next number; the others keep theirs.
  N.seed(view([row(2, "Novo", "sorcerer"), ...rows], { time_ms: 9000 }));
  assert.equal(N.name("Novo", {}), "Jogador 4");
  assert.equal(N.name("Mad", {}), "Jogador 1");
  // Your own name hidden too: "Você", and the others keep their numbers.
  N.set({ keepMe: false });
  assert.equal(N.name("Eu", { me: true }), "Você");
  // Recognized as you from the view even without the flag.
  assert.equal(N.name("Eu", {}), "Você");
  assert.equal(N.name("Zé", {}), "Jogador 2");
  // Monsters stay: only names of players seen are hidden.
  assert.equal(N.text("Ludra"), "Ludra");
  assert.equal(N.text("Fora"), "Jogador 3");
  assert.equal(N.text(""), "");
}

// "Classe 1, 2": numbered per class.
{
  const { N } = load();
  N.set({ on: true, style: "class", keepMe: false });
  N.seed(view([row(3, "Mad", "templar"), row(10, "Eu", "cleric", true), row(11, "Zé", "templar"), row(12, "Cura", "cleric"), row(13, "Sem", "")]));
  assert.equal(N.name("Mad", {}), "Templar 1");
  assert.equal(N.name("Eu", {}), "Você");
  assert.equal(N.name("Zé", {}), "Templar 2");
  // Another of your class is "Clérigo 1": you take no class number either.
  assert.equal(N.name("Cura", {}), "Clérigo 1");
  // Class not known: the plain number.
  assert.equal(N.name("Sem", {}), "Jogador 4");
  // Never seen by the meter: a window-only label.
  assert.equal(N.name("Misterio", {}), "Outro 1");
}

// A player first seen as "#id" keeps the number when the name comes.
{
  const { N } = load();
  N.set({ on: true });
  N.seed({ rows: [row(77, "#77", "")], time_ms: 1000 });
  assert.equal(N.name("#77", { id: 77 }), "Jogador 1");
  N.seed({ rows: [row(77, "Fulano", "gladiator")], time_ms: 2000 });
  assert.equal(N.name("Fulano", { id: 77 }), "Jogador 1");
}

// A new pull (the view's `pull`, from the fight history): numbers start
// again from the party, so the group's stay the same.
{
  const { N } = load();
  N.set({ on: true });
  N.seed(view([row(90, "Estranho", "ranger"), row(3, "Mad", "templar")], { time_ms: 60000, pull: 1 }));
  assert.equal(N.name("Estranho", {}), "Jogador 3");
  // A target switch mid-pull: the clock drops, the pull does not.
  N.seed(view([row(95, "Tarde", "ranger"), row(90, "Estranho", "ranger"), row(3, "Mad", "templar")], { time_ms: 2000, pull: 1 }));
  assert.equal(N.name("Estranho", {}), "Jogador 3");
  assert.equal(N.name("Tarde", {}), "Jogador 4");
  N.seed(view([row(3, "Mad", "templar"), row(91, "Novato", "sorcerer")], { time_ms: 30000, pull: 2 }));
  assert.equal(N.name("Mad", {}), "Jogador 1");
  assert.equal(N.name("Novato", {}), "Jogador 3");
  assert.equal(N.name("Estranho", {}), "Outro 1", "from the last pull: not numbered now");
}

// No `pull` (an older program): a target switch (the clock drops with no
// pause) keeps the numbers; rows back after being empty start again.
{
  const { N } = load();
  N.set({ on: true });
  const abc = [row(30, "A", "ranger"), row(20, "B", "sorcerer"), row(40, "C", "gladiator")];
  N.seed({ rows: abc, time_ms: 60000 });
  const before = abc.map((r) => N.name(r.name, { id: r.id }));
  N.seed({ rows: abc, time_ms: 3000 });
  assert.deepEqual(abc.map((r) => N.name(r.name, { id: r.id })), before);
  assert.deepEqual(before, ["Jogador 2", "Jogador 1", "Jogador 3"]);
  // The tracker itself: a drop after the clock stood still 10 s is a new fight.
  const t = N.fightTracker();
  assert.equal(t({ rows: abc, time_ms: 60000 }, 0), true);
  assert.equal(t({ rows: abc, time_ms: 3000 }, 1000), false, "target switch");
  assert.equal(t({ rows: abc, time_ms: 4000 }, 2000), false);
  assert.equal(t({ rows: abc, time_ms: 4000 }, 15000), false, "the fight is over, the clock stands");
  assert.equal(t({ rows: abc, time_ms: 1000 }, 16000), true, "the next pull");
  assert.equal(t({ rows: [], time_ms: 0 }, 17000), false);
  assert.equal(t({ rows: abc, time_ms: 500 }, 18000), true, "rows back after empty");
}

// A name the meter never showed (the cast's target, the greeting, a
// made-up player) does not move the numbers of this window.
{
  const a = load().N, b = load().N;
  a.set({ on: true });
  b.set({ on: true });
  assert.equal(a.name("Pet", {}), "Outro 1");
  assert.equal(a.name("Alguém", {}), "Outro 2");
  const v = view([row(50, "Fora", "ranger"), row(3, "Mad", "templar"), row(60, "Mais", "ranger")], { pull: 1 });
  a.seed(v);
  b.seed(v);
  for (const nm of ["Mad", "Zé", "Fora", "Mais"]) assert.equal(a.name(nm, {}), b.name(nm, {}), nm);
  // A made-up view ("Testar") is numbered on its own and never seeded.
  const demo = { demo: true, rows: [row(1, "Dark", "assassin", true), row(2, "IndioBala", "chanter")] };
  a.seed(demo);
  assert.equal(a.name("IndioBala", {}, "game", demo), "Jogador 1");
  assert.equal(a.name("IndioBala", {}), "Outro 1", "not in the real fight");
  assert.equal(a.name("Mais", {}), b.name("Mais", {}));
}

// Where: "game" leaves the settings window alone, "all" hides there too.
{
  const { N } = load();
  N.set({ on: true });
  assert.equal(N.active("game"), true);
  assert.equal(N.active("app"), false);
  assert.equal(N.name("Mad", {}, "app"), "Mad");
  N.set({ where: "all" });
  assert.equal(N.active("app"), true);
  assert.notEqual(N.name("Mad", {}, "app"), "Mad");
}

// A saved fight: its own numbering, highest damage first; off: real names.
{
  const { N } = load();
  const players = [
    { name: "Top", class: "sorcerer", dps: 9 },
    { name: "Eu", class: "cleric", dps: 5, me: true },
    { name: "Fim", class: "ranger", dps: 1 },
  ];
  assert.equal(N.list(players, "app")("Top"), "Top");
  N.set({ on: true, where: "all" });
  const nm = N.list(players, "app");
  assert.equal(nm("Top"), "Jogador 1");
  assert.equal(nm("Eu", { me: true }), "Eu");
  assert.equal(nm("Fim"), "Jogador 2");
  assert.equal(nm.text("Fim"), "Jogador 2");
  assert.equal(nm.text("Ludra"), "Ludra");
  N.set({ keepMe: false });
  assert.equal(N.list(players, "app")("Eu", { me: true }), "Você");
  // The copied image ("game") hides with the main switch, whatever "Onde esconder" says.
  N.set({ where: "game" });
  assert.equal(N.list(players, "app")("Top"), "Top");
  assert.equal(N.list(players, "game")("Top"), "Jogador 1");
}

// The Resumo keeps the live numbers (numbers()), so it reads as the meter did.
{
  const { N } = load();
  N.set({ on: true, where: "all" });
  N.seed(view([row(3, "Mad", "templar"), row(50, "Fora", "ranger"), row(10, "Eu", "cleric", true)], { pull: 1 }));
  assert.deepEqual({ ...N.numbers("Fora", 50) }, { no: 3, cno: 1 });
  assert.equal(N.numbers("Eu", 10), null, "you have no number");
  // Saved by damage (Fora first), drawn with the meter's numbers.
  const saved = [
    { name: "Fora", class: "ranger", dps: 9, ...N.numbers("Fora", 50) },
    { name: "Mad", class: "templar", dps: 5, ...N.numbers("Mad", 3) },
    { name: "Eu", class: "cleric", dps: 1, me: true },
    { name: "Velho", class: "ranger", dps: 1 },
  ];
  const nm = N.list(saved, "app");
  assert.equal(nm("Fora"), N.name("Fora", {}, "app"));
  assert.equal(nm("Mad"), "Jogador 1");
  assert.equal(nm("Velho"), "Jogador 4", "one with no number saved: after the others");
  N.set({ style: "class" });
  assert.equal(N.list(saved, "app")("Fora"), "Arqueiro 1");
  assert.equal(N.list(saved, "app")("Velho"), "Arqueiro 2");
}

// The quick switch, the listeners, and the setting read back by a new window.
{
  const { N, storage } = load();
  let calls = 0;
  N.onChange(() => calls++);
  assert.equal(N.toggle().on, true);
  assert.equal(N.toggle().on, false);
  assert.equal(calls, 2);
  N.set({ on: true, style: "class", where: "all", button: false, keepMe: false, announce: false });
  const other = load(storage).N;
  assert.deepEqual({ ...other.prefs }, { on: true, keepMe: false, style: "class", where: "all", button: false, announce: false, used: true });
  // Bad stored values fall back to the defaults.
  storage.set("ludra:hideNames", "{not json");
  assert.deepEqual({ ...load(storage).N.prefs }, { ...N.DEFAULTS });
  storage.set("ludra:hideNames", JSON.stringify({ on: 1, style: "x", where: "y" }));
  const odd = load(storage).N.prefs;
  assert.equal(odd.on, true);
  assert.equal(odd.style, "player");
  assert.equal(odd.where, "game");
}

// The quick button: only once the switch was turned on at least once.
{
  const { N } = load();
  assert.equal(N.showButton(), false);
  N.set({ on: true });
  N.set({ on: false });
  assert.equal(N.showButton(), true);
  N.set({ button: false });
  assert.equal(N.showButton(), false);
}

// The meter's table (meterview.js), drawn with a tiny made-up page: the
// names hidden, the button under it, and the data untouched.
{
  const make = (tag) => {
    const e = { tag, className: "", textContent: "", children: [], style: { setProperty() {} }, dataset: {}, on: {} };
    e.append = (...k) => e.children.push(...k);
    e.replaceChildren = (...k) => (e.children = [...k]);
    e.addEventListener = (t, f) => (e.on[t] = f);
    return e;
  };
  const storage = new Map();
  const localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) };
  const ctx = { window: { localStorage }, document: { createElement: make }, requestAnimationFrame: (f) => f() };
  ctx.window.document = ctx.document;
  ctx.window.requestAnimationFrame = ctx.requestAnimationFrame;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  vm.runInContext(readFileSync(new URL("../ui/meterview.js", import.meta.url), "utf8"), ctx);
  const N = ctx.window.LudraNames;
  const texts = (e, out = []) => {
    if (e.textContent) out.push(e.textContent);
    for (const c of e.children || []) texts(c, out);
    return out;
  };
  const find = (e, cls) => (e.className.split(" ").includes(cls) ? e : (e.children || []).map((c) => find(c, cls)).find(Boolean));
  const v = view([row(3, "Mad", "templar"), row(10, "Eu", "cleric", true)]);
  const before = JSON.stringify(v);
  N.set({ on: true });
  N.seed(v);
  const box = make("div");
  ctx.window.renderMeter(box, v);
  const all = texts(box).join(" | ");
  assert.ok(!all.includes("Mad"), all);
  assert.ok(all.includes("Jogador 1"), all);
  assert.ok(all.includes("Eu"), "your name stays by default");
  assert.equal(JSON.stringify(v), before);
  const btn = find(box, "mNames");
  assert.ok(btn && btn.className.includes("on"), "the button shows the names are hidden");
  assert.equal(btn.textContent, "🙈 Mostrar nomes", "named by what a click does");
  assert.ok(find(box, "mNamesTag"), "the plain tag for the locked meter");
  btn.on.click({ stopPropagation() {} });
  assert.equal(N.prefs.on, false, "the button turns it off");
  ctx.window.renderMeter(box, v);
  assert.ok(texts(box).join(" ").includes("Mad"));
  assert.equal(find(box, "mNames").textContent, "Esconder nomes");
  assert.equal(find(box, "mNamesTag"), undefined);
  // The settings window with "only over the game": real names there.
  N.set({ on: true });
  ctx.window.renderMeter(box, v, { scope: "app" });
  assert.ok(texts(box).join(" ").includes("Mad"));
  // The button turned off: no button.
  N.set({ button: false });
  ctx.window.renderMeter(box, v);
  assert.equal(find(box, "mNames"), undefined);
}

// The cast bar's target (bossview.js renderCasts): a monster keeps its name,
// a player the meter showed gets their number, one it did not "Outro N".
{
  const make = (tag) => {
    const e = { tag, className: "", textContent: "", children: [], style: {}, dataset: {} };
    e.classList = { toggle() {} };
    e.append = (...k) => e.children.push(...k);
    e.replaceChildren = (...k) => (e.children = [...k]);
    e.querySelectorAll = () => [];
    return e;
  };
  const storage = new Map();
  const localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) };
  const ctx = { window: { localStorage }, document: { createElement: make } };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  vm.runInContext(readFileSync(new URL("../ui/bossview.js", import.meta.url), "utf8"), ctx);
  const N = ctx.window.LudraNames;
  N.set({ on: true });
  N.seed(view([row(3, "Mad", "templar")], { pull: 1 }));
  const at = Date.now();
  const bar = (id, target, extra = {}) => ({ id, title: "CONE", known: true, start: at, end: at + 5000, target, targetMe: false, ...extra });
  const box = make("div");
  ctx.window.renderCasts(box, [bar("a", "Mad"), bar("b", "Espírito da Terra", { targetNpc: true }), bar("c", "Raidzinho")], { target: true });
  const aims = box.children.map((r) => r.children[0].children[1].textContent);
  assert.deepEqual(aims, ["em Jogador 1", "em Espírito da Terra", "em Outro 1"]);
  assert.equal(N.name("Zé", {}), "Jogador 2", "the shared numbers did not move");
}

console.log("ok names");
