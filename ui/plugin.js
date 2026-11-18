// Ludra BR: the page. The rules are in logic.js; this holds the settings, the
// voice, the big text and the log. Nothing leaves the computer: no network,
// only this computer's storage.
const $ = (s) => document.querySelector(s);
const DATA = window.LUDRA_BR;

const DEFAULTS = {
  enabled: true, widget: true, castCalls: true, hpCalls: true, prewarn: "3",
  size: "60", fg: "#ffd84d", bg: "#000000", bgOpacity: 80, showHp: true,
  speak: true, volume: 100, voiceName: "", rate: "1.15",
  thresholds: {}, maxHp: {}, off: {}, enrage: {},
};
let prefs = { ...DEFAULTS };
let gameOpen = false;
let live = null; // the boss now: { name, short, pct, approx, next }
let shown = []; // the calls on screen: { kind, text, sub, end, until }
let liveKey = ""; // what `live` showed last

const save = () => a2.storage.set("prefs", prefs).catch(() => {});
const enginePrefs = () => ({
  prewarn: Number(prefs.prewarn) || 0, hpCalls: prefs.hpCalls, castCalls: prefs.castCalls,
  thresholds: prefs.thresholds, maxHp: prefs.maxHp, off: prefs.off, enrage: prefs.enrage,
});

// ---- The voice ---------------------------------------------------------

const synth = window.speechSynthesis || null;
let voices = [];
const isPt = (v) => /^pt/i.test(v.lang || "");
function pickVoice() {
  if (prefs.voiceName) {
    const v = voices.find((x) => x.voiceURI === prefs.voiceName || x.name === prefs.voiceName);
    if (v) return v;
  }
  return voices.find((v) => /^pt[-_]br/i.test(v.lang)) || voices.find(isPt) || null;
}
function loadVoices() {
  voices = synth?.getVoices?.() || [];
  const sel = $(".voiceName");
  const keep = prefs.voiceName;
  sel.replaceChildren(new Option("Padrão (português)", ""));
  for (const v of [...voices].sort((a, b) => Number(isPt(b)) - Number(isPt(a)))) sel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI));
  sel.value = keep;
  const note = $(".voiceNote");
  if (!synth) note.textContent = "Este computador não tem vozes: só o bip e o texto na tela.";
  else if (voices.length && !voices.some(isPt)) note.textContent = "Nenhuma voz em português instalada. No Windows: Configurações > Hora e idioma > Fala > Adicionar vozes > Português (Brasil).";
  else note.textContent = "";
}
let audio = null;
function beep(high) {
  if (prefs.volume <= 0) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state !== "running") audio.resume().catch(() => {});
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = high ? 880 : 660;
    g.gain.value = 0.15 * Math.pow(prefs.volume / 100, 2);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.18);
  } catch {}
}
function say(text, urgent) {
  beep(urgent);
  if (!prefs.speak || !synth || !text || prefs.volume <= 0) return;
  if (urgent) synth.cancel(); // the call that matters now is heard now
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.lang = v?.lang || "pt-BR";
  u.rate = Number(prefs.rate) || 1;
  u.volume = Math.pow(prefs.volume / 100, 2);
  synth.speak(u);
}

// ---- The engine --------------------------------------------------------

const engine = window.LudraEngine.createEngine(DATA, {
  call(c) {
    if (!prefs.enabled) return;
    const at = Date.now();
    const until = c.end ? Math.max(c.end, at) + 1500 : at + (c.kind === "pre" ? 5000 : 8000);
    shown = [{ kind: c.kind, text: c.text, sub: c.sub, end: c.end || 0, until }, ...shown.filter((x) => x.until > at && x.text !== c.text)].slice(0, 2);
    say(c.say, c.kind !== "pre");
    send();
  },
  state(s) {
    if (live && !s) window.fightEnded?.();
    live = s;
    // Comes with each of the boss's HP records (many a second): the page and
    // the widget only when what they show changes.
    const k = s ? JSON.stringify([s.key, s.pct == null ? null : Math.round(s.pct * 10), s.approx, s.next?.title, s.next?.pct, s.pullAt, Math.round(s.dps / 50000), s.enrage]) : "";
    if (k === liveKey) return;
    liveKey = k;
    renderLive();
    send();
    window.bossLive?.(s);
  },
  savePrefs(p) {
    prefs.maxHp = p.maxHp;
    save();
  },
  saveLog(l) {
    a2.storage.set("log", l).catch(() => {});
    renderLog();
  },
});

// ---- The big text ------------------------------------------------------

let widgetOpen = false;
let lastSize = "";
const widgetSize = () => {
  const s = Number(prefs.size) || 60;
  // The meter holds a widget to 800 x 800. Tall enough for the HP strip and two
  // calls of two lines each; the areas let clicks through the rest.
  return { width: Math.round(Math.min(800, Math.max(560, s * 14))), height: Math.round(Math.min(800, s * 7 + 60)) };
};
async function placeWidget() {
  const want = prefs.enabled && prefs.widget && gameOpen;
  const size = JSON.stringify(widgetSize());
  if (!want) {
    if (widgetOpen) await a2.widgets.close("ludra").catch(() => {});
    widgetOpen = false;
    lastSize = "";
    return;
  }
  if (!widgetOpen || size !== lastSize) {
    await a2.widgets.open("ludra", widgetSize()).catch(() => {});
    widgetOpen = true;
    lastSize = size;
  }
  send();
}
window.refreshWidget = () => send();
function send() {
  if (!widgetOpen) return;
  const look = { size: Number(prefs.size) || 60, fg: prefs.fg, bg: prefs.bg, bgOpacity: prefs.bgOpacity / 100 };
  const now = Date.now();
  shown = shown.filter((x) => x.until > now);
  a2.widgets.send("ludra", { look, items: shown, live: prefs.showHp && !window.bossPanelOn?.() ? live : null }).catch(() => {});
}
setInterval(() => {
  engine.tick();
  renderStats();
  const n = shown.length;
  shown = shown.filter((x) => x.until > Date.now());
  if (shown.length !== n) send();
}, 500);

// ---- The page ----------------------------------------------------------

const fmtPct = (p) => (p == null ? "—" : `${p.toFixed(1).replace(".", ",")}%`);
function renderLive() {
  const name = $(".liveName"), fill = $(".fill"), pct = $(".pct"), next = $(".liveNext");
  if (!live) {
    name.textContent = "Esperando o boss";
    fill.style.width = "0%";
    pct.textContent = "—";
    next.textContent = "";
    return;
  }
  name.textContent = live.name;
  fill.style.width = `${Math.max(0, Math.min(100, live.pct ?? 0))}%`;
  pct.textContent = `${live.approx ? "≈ " : ""}${fmtPct(live.pct)}`;
  next.textContent = live.next ? `Próxima: ${live.next.title} em ${String(live.next.pct).replace(".", ",")}%` : "";
  renderStats();
}

// The fight's clock, the group's damage, when it dies at that pace, the enrage.
const clock = (s) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",")} mi` : `${Math.round(n / 1000)} mil`);
function fightStats(l, t = Date.now()) {
  if (!l || !l.pullAt) return [];
  const el = (t - l.pullAt) / 1000;
  const out = [`⏱ ${clock(el)}`];
  if (l.dps > 0) out.push(`${big(l.dps)}/s`, `mata em ${clock(l.cur / l.dps)}`);
  if (l.enrage > 0) out.push(el < l.enrage ? `enrage em ${clock(l.enrage - el)}` : "ENRAGE");
  return out;
}
window.fightStats = fightStats;
function renderStats() {
  const el = $(".liveStats");
  if (el) el.textContent = fightStats(live).join(" · ");
}

function renderBosses() {
  const box = $(".bosses");
  box.replaceChildren();
  for (const [key, b] of Object.entries(DATA.bosses)) {
    const det = document.createElement("details");
    det.open = key === "ludra";
    const sum = document.createElement("summary");
    sum.textContent = b.name;
    det.append(sum);
    const h = document.createElement("p");
    h.className = "note small";
    h.textContent = "Pela % de vida:";
    det.append(h);
    for (const t of b.hp) {
      const row = document.createElement("div");
      row.className = "mrow";
      const on = document.createElement("input");
      on.type = "checkbox";
      on.checked = !prefs.off[`${key}:${t.id}`];
      on.addEventListener("change", () => {
        prefs.off = { ...prefs.off, [`${key}:${t.id}`]: !on.checked };
        save();
        engine.setPrefs(enginePrefs());
      });
      const lab = document.createElement("span");
      lab.className = "mtitle";
      lab.textContent = t.title;
      lab.title = t.sub;
      const num = document.createElement("input");
      num.type = "number";
      num.min = "1";
      num.max = "99";
      num.step = "0.5";
      const own = prefs.thresholds[key]?.[t.id];
      num.value = String(own ?? t.pct);
      num.addEventListener("change", () => {
        const v = Math.min(99, Math.max(1, Number(num.value) || t.pct));
        num.value = String(v);
        prefs.thresholds = { ...prefs.thresholds, [key]: { ...(prefs.thresholds[key] || {}), [t.id]: v } };
        save();
        engine.setPrefs(enginePrefs());
      });
      const pc = document.createElement("span");
      pc.textContent = "%";
      row.append(on, lab, num, pc);
      det.append(row);
    }
    {
      const row = document.createElement("div");
      row.className = "mrow";
      const on = document.createElement("input");
      on.type = "checkbox";
      on.checked = !prefs.off[`${key}:enrage`];
      on.addEventListener("change", () => {
        prefs.off = { ...prefs.off, [`${key}:enrage`]: !on.checked };
        save();
        engine.setPrefs(enginePrefs());
      });
      const lab = document.createElement("span");
      lab.className = "mtitle";
      lab.textContent = "ENRAGE (min)";
      lab.title = "Avisa 1 minuto antes e na hora. 0 = sem enrage. O tempo dos guias não foi confirmado no global.";
      const num = document.createElement("input");
      num.type = "number";
      num.min = "0";
      num.max = "30";
      num.step = "0.5";
      num.value = String(engine.enrageSecs(key) / 60);
      num.addEventListener("change", () => {
        const v = Math.min(30, Math.max(0, Number(String(num.value).replace(",", ".")) || 0));
        num.value = String(v);
        prefs.enrage = { ...prefs.enrage, [key]: Math.round(v * 60) };
        save();
        engine.setPrefs(enginePrefs());
      });
      const pc = document.createElement("span");
      pc.textContent = "min";
      row.append(on, lab, num, pc);
      det.append(row);
    }
    const h2 = document.createElement("p");
    h2.className = "note small";
    h2.textContent = "Quando o boss usa:";
    det.append(h2);
    for (const c of [...b.casts, ...(b.buffCalls || [])]) {
      const k = c.skill ? `${key}:cast:${c.skill}` : `${key}:buff:${c.abnormal}`;
      if (det.querySelector(`[data-k="${k}"]`) || [...det.querySelectorAll(".mtitle")].some((x) => x.textContent === c.title && x.dataset.cast)) continue;
      const row = document.createElement("div");
      row.className = "mrow";
      const on = document.createElement("input");
      on.type = "checkbox";
      on.dataset.k = k;
      on.checked = !prefs.off[k];
      // Two skill ids with the same call (the orbs) are one switch.
      const same = [...b.casts, ...(b.buffCalls || [])].filter((x) => x.title === c.title).map((x) => (x.skill ? `${key}:cast:${x.skill}` : `${key}:buff:${x.abnormal}`));
      on.addEventListener("change", () => {
        const off = { ...prefs.off };
        for (const s of same) off[s] = !on.checked;
        prefs.off = off;
        save();
        engine.setPrefs(enginePrefs());
      });
      const lab = document.createElement("span");
      lab.className = "mtitle";
      lab.dataset.cast = "1";
      lab.textContent = c.title;
      const sub = document.createElement("span");
      sub.className = "msub";
      sub.textContent = c.sub;
      row.append(on, lab, sub);
      det.append(row);
    }
    box.append(det);
  }
}

const BOSS_NAME = (k) => DATA.bosses[k]?.short || "?";
function renderLog() {
  const body = $(".logTable tbody");
  const log = engine.getLog().slice().reverse().slice(0, 60);
  body.replaceChildren(
    ...log.map((e) => {
      const tr = document.createElement("tr");
      const d = new Date(e.at);
      const when = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const what = `${e.what?.title || "?"}${e.what?.n > 1 ? ` (${e.what.n}ª)` : ""}`;
      for (const v of [when, BOSS_NAME(e.boss), what, fmtPct(e.pct)]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      }
      return tr;
    }),
  );
}

// ---- Controls ----------------------------------------------------------

const keys = ["enabled", "widget", "castCalls", "hpCalls", "prewarn", "size", "fg", "bg", "bgOpacity", "showHp", "speak", "volume", "voiceName", "rate"];
function showPrefs() {
  for (const k of keys) {
    const el = $(`.${k}`);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!prefs[k];
    else el.value = String(prefs[k]);
  }
  $(".speakTop").checked = !!prefs.speak;
}
for (const k of keys) {
  const el = $(`.${k}`);
  if (!el) continue;
  el.addEventListener(el.type === "range" || el.type === "color" ? "input" : "change", () => {
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (k === "volume" || k === "bgOpacity") v = Number(v);
    prefs[k] = v;
    save();
    engine.setPrefs(enginePrefs());
    if (k === "enabled" || k === "widget" || k === "size") placeWidget();
    else send();
    if (k === "voiceName" || k === "rate") say("Bingo. Achem o quadrado azul.", true);
  });
}
$(".volume").addEventListener("change", () => say("Volume.", true));
// The voice switch at the top is the same as the one in "Aparência e voz".
$(".speakTop").addEventListener("change", (e) => {
  prefs.speak = e.target.checked;
  $(".speak").checked = prefs.speak;
  save();
  if (prefs.speak) say("Voz ligada.", true);
  else synth?.cancel();
});
$(".speak").addEventListener("change", () => ($(".speakTop").checked = !!prefs.speak));
$(".lock").addEventListener("change", (e) => a2.widgets.lock(e.target.checked).catch(() => {}));

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("isActive", t === tab);
    for (const p of document.querySelectorAll(".pane")) p.hidden = p.dataset.pane !== tab.dataset.tab;
  });
}

$(".test").addEventListener("click", async () => {
  const was = gameOpen;
  gameOpen = true; // so the big text shows even with the game shut
  await placeWidget();
  live = { name: "Ludra da Eternidade (teste)", short: "LUDRA", pct: 62.4, approx: false, next: { pct: 60, title: "BINGO 1" }, marks: [60, 45, 33, 25, 10], cur: 121_400_000, pullAt: Date.now() - 214_000, dps: 520_000, enrage: 600 };
  renderLive();
  window.bossLive?.(live, { stagger: 64, aggro: "Maximus", aggro_class: "templar", aggro_me: false });
  engine_call_test();
  setTimeout(() => {
    gameOpen = was;
    live = null;
    liveKey = "";
    renderLive();
    window.bossLive?.(null, null);
    placeWidget();
  }, 9000);
});
function engine_call_test() {
  const at = Date.now();
  shown = [{ kind: "cast", text: "BINGO!", sub: "Raio revela o quadrado. Todos no azul. Depois, batam tudo.", end: at + 6000, until: at + 7500 }];
  say("BINGO! Raio revela o quadrado. Todos no azul. Depois, batam tudo.", true);
  send();
}

$(".learn").addEventListener("click", () => {
  const learnt = engine.learnThresholds();
  const parts = [];
  const next = { ...prefs.thresholds };
  for (const [key, m] of Object.entries(learnt)) {
    next[key] = { ...(next[key] || {}), ...m };
    for (const [id, pct] of Object.entries(m)) {
      const t = DATA.bosses[key].hp.find((x) => x.id === id);
      parts.push(`${t ? t.title : id}: ${String(pct).replace(".", ",")}%`);
    }
  }
  $(".learnNote").textContent = parts.length ? `Ajustado: ${parts.join(" · ")}` : "Ainda não há lutas no registro para ajustar.";
  prefs.thresholds = next;
  save();
  engine.setPrefs(enginePrefs());
  renderBosses();
});
$(".copy").addEventListener("click", async () => {
  const lines = engine.getLog().map((e) => `${new Date(e.at).toISOString()}\t${BOSS_NAME(e.boss)}\t${e.what?.title || "?"}${e.what?.n > 1 ? ` #${e.what.n}` : ""}\t${e.pct ?? ""}`);
  const text = lines.join("\n");
  const ta = $(".logText");
  try {
    await navigator.clipboard.writeText(text);
    $(".learnNote").textContent = "Copiado. Cole no Discord.";
    ta.hidden = true;
  } catch {
    // The sandbox may block the clipboard: show the text to copy by hand.
    ta.hidden = false;
    ta.value = text;
    ta.select();
    $(".learnNote").textContent = "Selecione o texto abaixo e copie (Ctrl+C).";
  }
});
$(".clearLog").addEventListener("click", () => {
  engine.setLog([]);
  a2.storage.set("log", []).catch(() => {});
  renderLog();
});

// ---- The meter ---------------------------------------------------------

const atOf = (meta) => (meta && typeof meta.at === "number" ? meta.at : Date.now());
a2.on("decoded:npc-hp", (d, meta) => engine.hp(d, atOf(meta)));
a2.on("decoded:spawn", (d) => engine.spawn(d));
a2.on("decoded:boss-cast", (d, meta) => engine.cast(d, atOf(meta), "cast"));
a2.on("decoded:boss-skill", (d, meta) => engine.cast(d, atOf(meta), "use"));
a2.on("decoded:boss-buff", (d, meta) => engine.buff(d, atOf(meta)));
a2.on("game", (d) => {
  const open = !!(d && d.running);
  if (open === gameOpen) return;
  gameOpen = open;
  if (!open) {
    engine.clear();
    shown = [];
  }
  placeWidget();
});
a2.on("locked", (on) => {
  $(".lock").checked = !!on;
});
a2.on("widget-message", ({ data }) => {
  if (data && data.open) a2.window?.show?.();
  if (data && data.hello) send(); // a widget just loaded: what was sent before it was lost
});

if (synth) {
  loadVoices();
  if (typeof synth.addEventListener === "function") synth.addEventListener("voiceschanged", loadVoices);
  else synth.onvoiceschanged = loadVoices;
} else loadVoices();

(async () => {
  const stored = await a2.storage.get("prefs").catch(() => null);
  if (stored && typeof stored === "object") prefs = { ...DEFAULTS, ...stored };
  // The mechanics come set up: the same calls, at the same %, for everyone.
  for (const k of ["castCalls", "hpCalls", "prewarn", "thresholds", "off", "enrage"]) prefs[k] = DEFAULTS[k];
  const log = await a2.storage.get("log").catch(() => null);
  engine.setLog(log);
  engine.setPrefs(enginePrefs());
  $(".lock").checked = await a2.widgets.locked().catch(() => false);
  showPrefs();
  loadVoices();
  renderBosses();
  for (const el of document.querySelectorAll('[data-pane="mec"] input, [data-pane="mec"] select')) el.disabled = true;
  renderLive();
  renderLog();
  placeWidget();
  a2.ready();
})();

// ---- Sending the log to the people who tune the calls -------------------

const logLines = (from) =>
  engine
    .getLog()
    .filter((e) => e.at > from)
    .map((e) => `${new Date(e.at).toISOString()}\t${BOSS_NAME(e.boss)}\t${e.what?.title || "?"}${e.what?.n > 1 ? ` #${e.what.n}` : ""}\t${e.pct ?? ""}`);
let sentUpTo = Number(localStorage.getItem("ludra:sentUpTo")) || 0;
async function sendLog(auto) {
  const lines = logLines(auto ? sentUpTo : 0);
  if (!lines.length) {
    if (!auto) $(".learnNote").textContent = "Ainda não há luta no registro. Depois de uma luta no Ludra (Rahu, Ketu ou Ludra), é só enviar.";
    return;
  }
  const btn = $(".sendLog");
  btn.disabled = true;
  $(".learnNote").textContent = "Enviando…";
  try {
    await window.__TAURI__.core.invoke("send_log", { text: lines.join("\n"), note: `${lines.length} linhas${auto ? " (automático)" : ""}` });
    sentUpTo = Math.max(...engine.getLog().map((e) => e.at), sentUpTo);
    try {
      localStorage.setItem("ludra:sentUpTo", String(sentUpTo));
    } catch {}
    $(".learnNote").textContent = "Enviado. Valeu por ajudar!";
  } catch (err) {
    $(".learnNote").textContent = String(err);
  }
  btn.disabled = false;
}
$(".sendLog").addEventListener("click", () => sendLog(false));
{
  const sw = $(".autoSend");
  sw.checked = localStorage.getItem("ludra:autoSend") === "1";
  sw.addEventListener("change", () => {
    try {
      localStorage.setItem("ludra:autoSend", sw.checked ? "1" : "0");
    } catch {}
  });
}
// The boss gone (dead, or the group wiped): a few seconds on, the new lines go.
window.fightEnded = () => {
  if ($(".autoSend").checked) setTimeout(() => sendLog(true), 5000);
};
