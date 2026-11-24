// "Histórico": every boss fight the program saved on this PC (the backend's
// history_list / history_get / history_delete / history_bests), the DPS of
// each player over the fight on a chart with the boss's HP, your skills, and
// your records per boss. A new record is called on the big text.
//
// "Linha do tempo": each saved fight can be played back: the boss's HP over
// time, a marker for each mechanic, death, Bingo and stagger break, and a play
// button that walks through the fight (HP, the last mechanic, who was alive).
// The meter keeps the HP, deaths and breaks (src/history.rs); the mechanics
// are this page's calls (logic.js), added to the fight once it is saved. The
// idea follows Aion2Flow's timeline playback and aletheia's skill map.
//
// The pure parts (numbers, the chart's lines) are in window.LudraHistory for
// the tests; the page is drawn only when the pane is there.
(function (root) {
  const R = root.LudraRecap;
  const num = (n) => {
    if (R && R.num) return R.num(n);
    n = Math.max(0, Number(n) || 0);
    if (n < 1000) return String(Math.round(n));
    if (n < 999_500) return `${Math.round(n / 1000)} mil`;
    const m = n / 1e6;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "").replace(".", ",")} mi`;
  };
  const dur = (ms) => {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const pctText = (p) => `${String(Math.round((Number(p) || 0) * 10) / 10).replace(".", ",")}%`;
  // "Vitória" or "Wipe (até 43,5%)".
  const result = (f) => (f && f.won ? "Vitória" : `Wipe (até ${pctText(f && f.low_pct)})`);
  // "22/11 14:05" (pt-BR), from the id/at time in ms.
  const when = (ms) => {
    const d = new Date(Number(ms) || 0);
    if (!(d.getTime() > 0)) return "";
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  // The big text when a record falls.
  const bestCall = (b) => {
    const boss = (b && b.boss) || "boss";
    const before = b && b.previous > 0 ? ` (antes ${num(b.previous)})` : "";
    return {
      kind: "cast",
      text: `NOVO RECORDE! ${num(b && b.dps)} DPS no ${boss}${before}`,
      sub: "Seu melhor DPS nesse boss com este personagem.",
      say: `Novo recorde. ${num(b && b.dps)} de DPS no ${boss}`,
    };
  };
  // Players' lines on the chart: { name, pts: [[t_ms, dps]] }, and the boss's [[t_ms, pct]].
  function series(timeline) {
    const tl = Array.isArray(timeline) ? timeline : [];
    const by = new Map();
    const boss = [];
    for (const p of tl) {
      const t = Number(p.t_ms) || 0;
      if (p.boss_pct != null) boss.push([t, Number(p.boss_pct)]);
      for (const [name, dps] of p.dps || []) {
        if (!by.has(name)) by.set(name, []);
        by.get(name).push([t, Number(dps) || 0]);
      }
    }
    const t1 = tl.length ? Number(tl[tl.length - 1].t_ms) || 0 : 0;
    let top = 0;
    for (const pts of by.values()) for (const [, v] of pts) top = Math.max(top, v);
    return { players: [...by].map(([name, pts]) => ({ name, pts })), boss, t1, top };
  }
  // A round top for the DPS axis (50 mil, 100 mil, 150 mil...).
  function niceTop(v) {
    if (!(v > 0)) return 1000;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  const bossesOf = (list) => [...new Set((list || []).map((f) => f.boss).filter(Boolean))];

  // ---- "Linha do tempo" -------------------------------------------------------
  // Options, kept on this PC. timeline/keep also go to the program (it saves
  // the fights); the rest only change what the page draws.
  const OPTS_KEY = "ludra:hist";
  const KEEP_CHOICES = [50, 100, 200, 300, 500, 1000];
  const SPEEDS = [1, 2, 5, 10, 20];
  const OPTS_DEFAULTS = { timeline: true, keep: 300, showMech: true, showDeaths: true, showStagger: true, showRevive: true, speed: 5 };
  function cleanOpts(raw) {
    const o = { ...OPTS_DEFAULTS };
    if (!raw || typeof raw !== "object") return o;
    for (const k of ["timeline", "showMech", "showDeaths", "showStagger", "showRevive"]) if (typeof raw[k] === "boolean") o[k] = raw[k];
    if (KEEP_CHOICES.includes(Number(raw.keep))) o.keep = Number(raw.keep);
    if (SPEEDS.includes(Number(raw.speed))) o.speed = Number(raw.speed);
    return o;
  }
  // The fight has something to play back (older ones, or saved with it off, have not).
  const hasReplay = (f) => !!f && ((Array.isArray(f.hp) && f.hp.length > 1) || (Array.isArray(f.deaths) && f.deaths.length > 0) || (Array.isArray(f.marks) && f.marks.length > 0));
  // The fight's length for the replay: its duration, or its last point.
  const replayEnd = (f) => {
    let t = Number(f && f.duration_ms) || 0;
    for (const p of (f && f.hp) || []) t = Math.max(t, Number(p[0]) || 0);
    for (const d of (f && f.deaths) || []) t = Math.max(t, Number(d.t_ms) || 0);
    return t;
  };
  const isBingo = (e) => (e.what && e.what.skill === 1803010) || /bingo/i.test(String((e.what && e.what.title) || ""));
  // The mechanics this page called during a saved fight, for the program to
  // keep with it: from the engine's log, the fight's boss (by its code in
  // data.js), from just before the pull to just after the end. Unknown skills
  // ("skill 123") stay out, like on the Resumo; a call logged twice within 2 s
  // (the cast, then the hit) is one marker.
  function collectMarks(log, f, bosses) {
    if (!f) return [];
    const id = Number(f.id) || 0;
    const end = id + (Number(f.duration_ms) || 0) + 3000;
    const keys = Object.keys(bosses || {}).filter((k) => (bosses[k].codes || []).includes(Number(f.code)));
    if (!keys.length) return [];
    const out = [];
    for (const e of log || []) {
      if (!e || !e.what || !(e.at >= id - 2000 && e.at <= end) || !keys.includes(e.boss)) continue;
      const raw = String(e.what.title || "");
      if (!raw || /^(skill|efeito) /.test(raw)) continue;
      const title = `${raw.replace(/!+/g, "").trim()}${e.what.n > 1 ? ` ${e.what.n}` : ""}`;
      const t_ms = Math.max(0, Math.round(e.at - id));
      if (out.some((m) => m.title === title && Math.abs(m.t_ms - t_ms) <= 2000)) continue;
      out.push({ t_ms, kind: isBingo(e) ? "bingo" : "mech", title, pct: e.pct != null && isFinite(e.pct) ? Number(e.pct) : null });
    }
    return out.sort((a, b) => a.t_ms - b.t_ms).slice(0, 300);
  }
  // All markers, in time order: { t, kind, title, pct, ...death fields }.
  function marksOf(f) {
    const out = [];
    for (const m of (f && f.marks) || []) out.push({ t: Number(m.t_ms) || 0, kind: m.kind || "mech", title: m.title || "", pct: m.pct ?? null });
    for (const d of (f && f.deaths) || []) out.push({ t: Number(d.t_ms) || 0, kind: "death", title: d.name || "", name: d.name || "", cls: d.class || "", me: !!d.me, killer: d.killer || "", skill: d.skill || "", damage: Number(d.damage) || 0, pct: null });
    out.sort((a, b) => a.t - b.t);
    // The boss's HP at each death, from the HP line.
    for (const m of out) if (m.pct == null) m.pct = hpAt(f && f.hp, m.t);
    return out;
  }
  // The boss's HP at `t` (straight between two points; null: no points).
  function hpAt(hp, t) {
    if (!Array.isArray(hp) || !hp.length) return null;
    if (t <= hp[0][0]) return Number(hp[0][1]);
    for (let i = 1; i < hp.length; i++) {
      const [t1, v1] = hp[i];
      if (t <= t1) {
        const [t0, v0] = hp[i - 1];
        const k = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
        return Math.round((Number(v0) + (Number(v1) - Number(v0)) * k) * 10) / 10;
      }
    }
    return Number(hp[hp.length - 1][1]);
  }
  // The last mechanic called by `t` (mech or Bingo), or null.
  const lastMech = (marks, t) => (marks || []).filter((m) => (m.kind === "mech" || m.kind === "bingo") && m.t <= t).at(-1) || null;
  // Who was up and who was down at `t`. A death lasts until a revive the
  // party frames saw; with none (no party, or a fight saved before it), until
  // the player shows damage again on the DPS line (5 s points).
  function aliveAt(f, t) {
    const names = [];
    const add = (n) => n && !names.includes(n) && names.push(n);
    for (const p of (f && f.players) || []) add(p.name);
    for (const d of (f && f.deaths) || []) add(d.name);
    const revives = ((f && f.marks) || []).filter((m) => m.kind === "revive");
    const tl = (f && f.timeline) || [];
    const upAgain = (name, td) => {
      const r = revives.find((m) => m.title === name && m.t_ms > td);
      if (r) return r.t_ms;
      // A 5 s point after the death with damage in it: up again within it.
      const p = tl.find((x) => x.t_ms >= td + 6000 && (x.dps || []).some(([n, v]) => n === name && v > 0));
      return p ? Math.max(td + 1, p.t_ms - 5000) : Infinity;
    };
    const dead = new Set();
    for (const d of (f && f.deaths) || []) {
      const td = Number(d.t_ms) || 0;
      if (td <= t && t < upAgain(d.name, td)) dead.add(d.name);
    }
    return { alive: names.filter((n) => !dead.has(n)), dead: names.filter((n) => dead.has(n)) };
  }
  // The marker nearest `t` within `tol` ms, of the kinds shown.
  function nearestMark(marks, t, tol, kinds) {
    let best = null;
    for (const m of marks || []) {
      if (kinds && !kinds.includes(m.kind)) continue;
      const d = Math.abs(m.t - t);
      if (d <= tol && (!best || d < Math.abs(best.t - t))) best = m;
    }
    return best;
  }
  // How many saved fights a smaller "Quantas lutas guardar" deletes at the
  // next save: the oldest past `keep`, but not the records' fights (🏆), which
  // the program keeps (src/history.rs, Store::save). `list`: history_list.
  function keepLoss(list, keep) {
    const all = Array.isArray(list) ? list : [];
    const over = all.length - (Number(keep) || 0);
    if (over <= 0) return 0;
    return Math.min(over, all.filter((f) => !f.best).length);
  }
  // The kinds a viewer chose to see.
  const shownKinds = (o) => [...(o.showMech ? ["mech", "bingo"] : []), ...(o.showDeaths ? ["death"] : []), ...(o.showStagger ? ["stagger"] : []), ...(o.showRevive ? ["revive"] : [])];
  // A marker's words: { head, body } ("0:42 · Bingo", "Vida do boss: 63,5%").
  // nm: "Esconder nomes".
  function markText(m, nm) {
    const N = nm || Object.assign((n) => n, { text: (n) => n });
    const who = (n) => N(n, { me: m.me, cls: m.cls });
    const hp = m.pct != null ? `Vida do boss: ${pctText(m.pct)}` : "";
    const at = dur(m.t);
    if (m.kind === "death") {
      const sk = R && R.skillName ? R.skillName(m.skill) : m.skill;
      const kl = R && R.who ? R.who(m.killer) : m.killer;
      const how = sk ? `Golpe que matou: ${sk}${kl ? ` (${N.text ? N.text(kl) : kl})` : ""}${m.damage > 0 ? `, ${num(m.damage)}` : ""}` : "O medidor não viu golpe: provavelmente uma mecânica que mata direto.";
      return { head: `${at} · ☠ ${who(m.name)} morreu`, body: [how, hp].filter(Boolean).join("\n") };
    }
    if (m.kind === "revive") return { head: `${at} · ✚ ${who(m.title)} voltou`, body: hp };
    if (m.kind === "stagger") return { head: `${at} · Stagger quebrado`, body: [hp, "O boss ficou atordoado."].filter(Boolean).join("\n") };
    return { head: `${at} · ${m.kind === "bingo" ? "🎯 " : ""}${m.title || "Mecânica"}`, body: hp };
  }

  // ---- demo (no game, no backend) -------------------------------------------
  const DEMO_PLAYERS = [
    { name: "Dark", class: "assassin", me: true, dps: 81100, total: 13.7e6, deaths: 1, cp: 193600 },
    { name: "IndioBala", class: "chanter", me: false, dps: 40000, total: 6.8e6, deaths: 0, cp: 196700 },
    { name: "JSHOW", class: "sorcerer", me: false, dps: 36600, total: 6.2e6, deaths: 0, cp: 173800 },
    { name: "Tankão", class: "templar", me: false, dps: 15500, total: 2.6e6, deaths: 0, cp: 162300 },
    { name: "RickSanchez", class: "cleric", me: false, dps: 7900, total: 1.3e6, deaths: 2, cp: 131800 },
  ];
  function demoTimeline(ms) {
    const out = [];
    for (let t = 0; t <= ms; t += 5000) {
      const k = t / ms;
      out.push({
        t_ms: t,
        boss_pct: Math.max(0, 100 - k * 100),
        dps: DEMO_PLAYERS.map((p, i) => [p.name, Math.max(0, p.dps * (0.7 + 0.3 * Math.sin(t / 9000 + i)) + (t < 15000 ? -p.dps * 0.3 : 0))]),
      });
    }
    return out;
  }
  const now0 = Date.now();
  const DEMO = [
    { id: now0 - 3600_000, boss: "Ludra da Eternidade", code: 2301014, won: true, duration_ms: 169000, low_pct: 0, my_dps: 81100, best: true },
    { id: now0 - 5400_000, boss: "Ludra da Eternidade", code: 2301014, won: false, duration_ms: 141000, low_pct: 43.5, my_dps: 74200, best: false },
    { id: now0 - 7200_000, boss: "Rahu da Disjunção", code: 2301006, won: true, duration_ms: 122000, low_pct: 0, my_dps: 69800, best: true },
  ];
  // The demo's replay: HP each second (a pause at the Bingo), a few calls and deaths.
  function demoReplay(f) {
    const hp = [];
    const end = f.won ? 0 : f.low_pct;
    // The boss barely moves for 12 s after the first minute (the Bingo).
    const te = (t) => (t < 60000 ? t : t < 72000 ? 60000 + (t - 60000) * 0.2 : t - 9600);
    for (let t = 0; t <= f.duration_ms; t += 1000) {
      const k = te(t) / te(f.duration_ms);
      hp.push([t, Math.round(Math.max(end, 100 - (100 - end) * k) * 10) / 10]);
    }
    const at = (k) => Math.round(f.duration_ms * k);
    return {
      hp,
      deaths: [
        { t_ms: at(0.38), name: "RickSanchez", class: "cleric", me: false, killer: "Ludra da Eternidade", skill: "Raio em linha", damage: 85000 },
        { t_ms: at(0.55), name: "Dark", class: "assassin", me: true, killer: "Ludra da Eternidade", skill: "Explosão do Trovão", damage: 120000 },
        { t_ms: at(0.8), name: "RickSanchez", class: "cleric", me: false, killer: "", skill: "", damage: 0 },
      ],
      marks: [
        { t_ms: at(0.12), kind: "mech", title: "Zona do Trovão", pct: hpAt(hp, at(0.12)) },
        { t_ms: at(0.3), kind: "stagger", title: "Stagger quebrado", pct: hpAt(hp, at(0.3)) },
        { t_ms: at(0.36), kind: "bingo", title: "Bingo", pct: hpAt(hp, at(0.36)) },
        { t_ms: at(0.47), kind: "revive", title: "RickSanchez", pct: null },
        { t_ms: at(0.62), kind: "mech", title: "Provação de Ludra", pct: hpAt(hp, at(0.62)) },
        { t_ms: at(0.66), kind: "revive", title: "Dark", pct: null },
        { t_ms: at(0.75), kind: "bingo", title: "Bingo 2", pct: hpAt(hp, at(0.75)) },
      ],
    };
  }
  const demoGet = (id) => {
    const f = DEMO.find((x) => x.id === id);
    if (!f) return null;
    return {
      ...f,
      // The third demo fight is an "old" one: no replay, the friendly note.
      ...(f === DEMO[2] ? {} : demoReplay(f)),
      me: "Dark",
      players: DEMO_PLAYERS.map((p) => ({ ...p, dps: p.me ? f.my_dps : p.dps })),
      timeline: demoTimeline(f.duration_ms),
      skills_me: [
        { id: 1, name: "Golpe Sombrio", total: 4.1e6, hits: 120, crit_pct: 61, share: 30, max: 98000, dps: 24300 },
        { id: 2, name: "Lâmina Venenosa", total: 3.2e6, hits: 88, crit_pct: 55, share: 23, max: 71000, dps: 18900 },
        { id: 3, name: "Ataque Rápido", total: 2.5e6, hits: 301, crit_pct: 48, share: 18, max: 22000, dps: 14800 },
        { id: 4, name: "Emboscada", total: 1.9e6, hits: 14, crit_pct: 79, share: 14, max: 210000, dps: 11200 },
      ],
    };
  };
  const DEMO_BESTS = [
    { boss: "Ludra da Eternidade", code: 2301014, character: "Dark", dps: 81100, id: DEMO[0].id, at_ms: DEMO[0].id },
    { boss: "Rahu da Disjunção", code: 2301006, character: "Dark", dps: 69800, id: DEMO[2].id, at_ms: DEMO[2].id },
  ];

  root.LudraHistory = { num, dur, result, when, bestCall, series, niceTop, bossesOf, demoGet, DEMO, DEMO_BESTS, OPTS_DEFAULTS, KEEP_CHOICES, SPEEDS, cleanOpts, hasReplay, replayEnd, collectMarks, marksOf, hpAt, lastMech, aliveAt, nearestMark, shownKinds, markText, keepLoss };

  // ---- the page --------------------------------------------------------------
  const doc = root.document;
  const pane = doc && doc.querySelector('.pane[data-pane="hist"]');
  if (!pane) return;
  const K = root.meterKit || {};
  const COLORS = K.COLORS || {};
  const el = K.el || ((tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  });
  const icon = K.icon || (() => el("span"));
  const T = root.__TAURI__;
  const invoke = T && T.core && T.core.invoke;
  let demo = !invoke;
  const call = async (cmd, args) => {
    if (demo) {
      if (cmd === "history_list") return DEMO;
      if (cmd === "history_get") return demoGet(args.id);
      if (cmd === "history_bests") return DEMO_BESTS;
      if (cmd === "history_delete") {
        const i = DEMO.findIndex((x) => x.id === args.id);
        if (i >= 0) DEMO.splice(i, 1);
        return null;
      }
      return null;
    }
    return invoke(cmd, args || {});
  };

  // ---- options ("Opções do histórico") ---------------------------------------
  let opts = OPTS_DEFAULTS;
  try {
    opts = cleanOpts(JSON.parse(localStorage.getItem(OPTS_KEY) || "null"));
  } catch {}
  const saveOpts = () => {
    try {
      localStorage.setItem(OPTS_KEY, JSON.stringify(opts));
    } catch {}
  };
  // The program saves the fights: it needs these two.
  const sendOpts = () => {
    if (!demo) call("history_options", { timeline: opts.timeline, keep: opts.keep }).catch(() => {});
  };
  const optBox = pane.querySelector(".hOpts");
  const optUi = optBox && {
    timeline: optBox.querySelector(".hTimeline"),
    keep: optBox.querySelector(".hKeep"),
    showMech: optBox.querySelector(".hShowMech"),
    showDeaths: optBox.querySelector(".hShowDeaths"),
    showStagger: optBox.querySelector(".hShowStagger"),
    showRevive: optBox.querySelector(".hShowRevive"),
    speed: optBox.querySelector(".hSpeed"),
  };
  // The "Mostrar" switches stay fully active with saving off: they still
  // apply to every fight already saved with a timeline.
  function showOpts() {
    if (!optUi) return;
    for (const k of ["timeline", "showMech", "showDeaths", "showStagger", "showRevive"]) if (optUi[k]) optUi[k].checked = opts[k];
    if (optUi.keep) optUi.keep.value = String(opts.keep);
    if (optUi.speed) optUi.speed.value = String(opts.speed);
  }
  function setOpt(k, v) {
    opts = cleanOpts({ ...opts, [k]: v });
    saveOpts();
    showOpts();
    if (k === "timeline" || k === "keep") sendOpts();
    if (k === "speed") {
      const now = view && view.querySelector(".hSpeedNow");
      if (now) now.value = String(opts.speed);
    }
    // Only the open fight's replay is drawn again (not the whole fight), at
    // the same moment and still playing if it was.
    else if (k !== "keep") redrawReplay();
  }
  // A smaller "Quantas lutas guardar" deletes old fights at the next save and
  // cannot be undone: asked first, on the card (like "Apagar").
  function askKeep(n) {
    const loss = keepLoss(list, n);
    optBox.querySelector(".hKeepAsk")?.remove();
    if (loss <= 0) return setOpt("keep", n);
    const ask = el("div", "hAsk hKeepAsk");
    const yes = el("button", "btn danger", "Sim");
    yes.type = "button";
    const no = el("button", "btn", "Cancelar");
    no.type = "button";
    ask.append(el("span", "", `Vai apagar ${loss === 1 ? "a luta mais antiga" : `as ${loss} lutas mais antigas`} quando a próxima luta for salva (os recordes 🏆 ficam). Continuar?`), yes, no);
    yes.addEventListener("click", () => {
      ask.remove();
      setOpt("keep", n);
    });
    no.addEventListener("click", () => {
      ask.remove();
      optUi.keep.value = String(opts.keep);
    });
    optUi.keep.closest(".switch").after(ask);
  }
  if (optUi) {
    for (const k of ["timeline", "showMech", "showDeaths", "showStagger", "showRevive"]) optUi[k]?.addEventListener("change", () => setOpt(k, optUi[k].checked));
    optUi.keep?.addEventListener("change", () => askKeep(Number(optUi.keep.value)));
    optUi.speed?.addEventListener("change", () => setOpt("speed", Number(optUi.speed.value)));
  }
  // "Opções" on a replay: opens the card (above the list) and shows it.
  const openOpts = () => {
    if (!optBox) return;
    optBox.open = true;
    optBox.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  showOpts();
  sendOpts();

  const listBox = pane.querySelector(".hList");
  const filter = pane.querySelector(".hFilter");
  const bestBox = pane.querySelector(".hBests");
  const view = pane.querySelector(".hView");
  let list = [];
  let open = null; // the fight shown

  async function refresh() {
    try {
      list = (await call("history_list")) || [];
    } catch {
      list = [];
    }
    let bests = [];
    try {
      bests = (await call("history_bests")) || [];
    } catch {}
    renderFilter();
    renderList();
    renderBests(bests);
  }

  function renderFilter() {
    if (!filter) return;
    const cur = filter.value;
    filter.replaceChildren();
    const all = el("option", "", "Todos os bosses");
    all.value = "";
    filter.append(all);
    for (const b of bossesOf(list)) {
      const o = el("option", "", b);
      o.value = b;
      filter.append(o);
    }
    filter.value = bossesOf(list).includes(cur) ? cur : "";
  }

  function renderList() {
    listBox.replaceChildren();
    const shown = list.filter((f) => !filter || !filter.value || f.boss === filter.value);
    if (!shown.length) {
      listBox.append(el("p", "note", list.length ? "Nenhuma luta desse boss." : "Nenhuma luta salva ainda. Cada luta contra um boss fica salva aqui quando termina."));
      return;
    }
    for (const f of shown) {
      const row = el("button", `hRow${f.won ? " won" : " wipe"}${open && open.id === f.id ? " isOpen" : ""}`);
      row.type = "button";
      row.append(
        el("span", "hWhen", when(f.id)),
        el("span", "hBoss", f.boss || "Boss"),
        el("span", `hRes ${f.won ? "won" : "wipe"}`, result(f)),
        el("span", "hDur", dur(f.duration_ms)),
        el("span", "hDps", f.my_dps > 0 ? `${num(f.my_dps)}/s` : "—"),
        el("span", "hBest", f.best ? "🏆" : ""),
      );
      if (f.best) row.title = "Recorde pessoal nesse boss";
      row.addEventListener("click", () => show(f.id));
      listBox.append(row);
    }
  }

  function renderBests(bests) {
    if (!bestBox) return;
    bestBox.replaceChildren(el("h3", "", "🏆 Recordes"));
    if (!bests.length) {
      bestBox.append(el("p", "note", "Seu melhor DPS em cada boss aparece aqui."));
      return;
    }
    const me = bests[0].character;
    if (me) bestBox.append(el("p", "note", `Personagem: ${me}`));
    for (const b of bests) {
      const r = el("div", "hBestRow");
      r.append(el("span", "", b.boss), el("b", "", `${num(b.dps)}/s`), el("span", "note", when(b.at_ms || b.id)));
      bestBox.append(r);
    }
  }

  // The settings window's scroller (.main): kept when the open fight is drawn
  // again (a new save, "Esconder nomes"), so the page does not jump.
  const scroller = pane.closest(".main") || doc.scrollingElement;
  async function show(id) {
    // The same fight drawn again keeps its replay's moment and play.
    const same = !!(open && open.id === id);
    const prev = stopReplay();
    const start = prev && prev.id === id ? prev : null;
    const top = scroller ? scroller.scrollTop : 0;
    let f = null;
    try {
      f = await call("history_get", { id });
    } catch {}
    open = f;
    renderList();
    view.replaceChildren();
    if (!f) {
      view.append(el("p", "note", "Não deu para abrir essa luta."));
      return;
    }
    const card = el("div", `card fight hFight${f.won ? " won" : " wipe"}`);
    const head = el("div", "fHead");
    const title = el("div", "fTitle");
    title.append(el("b", "", f.boss || "Boss"), el("span", `fRes ${f.won ? "won" : "wipe"}`, result(f)));
    head.append(title, el("div", "fMeta", `${when(f.id)} · ${dur(f.duration_ms)}`));
    card.append(head);

    // Players, highest DPS first.
    const players = (f.players || []).slice().sort((a, b) => b.dps - a.dps);
    const nm = namesOf(players);
    if (!players.length) card.append(el("p", "note", "O medidor não pegou dano nessa luta."));
    players.forEach((p, i) => {
      const row = el("div", `fRow${p.me ? " me" : ""}`);
      row.style.setProperty("--c", COLORS[p.class] || "#8892a6");
      row.append(el("span", "fPos", `${i + 1}`), icon(p.class), el("span", "fName", nm(p.name, { me: p.me, cls: p.class })), el("span", "fTotal", num(p.total)), el("span", "fDps", `${num(p.dps)}/s`), el("span", "fDead", p.deaths ? `☠ ${p.deaths}` : ""));
      card.append(row);
    });

    // The chart.
    card.append(el("h3", "hH", "DPS ao longo da luta"));
    const cv = el("canvas", "hChart");
    card.append(cv);
    const legend = el("div", "hLegend");
    card.append(legend);

    // The replay.
    card.append(el("h3", "hH", "Linha do tempo"));
    const replayBox = el("div", "hReplay");
    card.append(replayBox);

    // Your skills.
    const skills = f.skills_me || [];
    card.append(el("h3", "hH", "Suas habilidades"));
    if (!skills.length) card.append(el("p", "note", "Sem habilidades registradas nessa luta."));
    else {
      const t = el("table", "hSkills");
      const hr = el("tr");
      for (const h of ["Habilidade", "Dano", "%", "Golpes", "Crítico", "Maior golpe"]) hr.append(el("th", "", h));
      t.append(hr);
      for (const s of skills) {
        const r = el("tr");
        r.append(el("td", "", s.name || `#${s.id}`), el("td", "", num(s.total)), el("td", "", pctText(s.share)), el("td", "", String(s.hits || 0)), el("td", "", pctText(s.crit_pct)), el("td", "", num(s.max)));
        t.append(r);
      }
      card.append(t);
    }

    // Buttons.
    const acts = el("div", "fActs");
    const copy = el("button", "btn", "Copiar imagem");
    copy.type = "button";
    const del = el("button", "btn danger", "Apagar");
    del.type = "button";
    const note = el("span", "note fNote", "");
    copy.addEventListener("click", () => copyImage(f, note));
    del.addEventListener("click", () => askDelete(f, acts));
    acts.append(copy, del, note);
    card.append(acts);
    view.append(card);

    const s = series(f.timeline);
    const playerInfo = (name) => {
      const p = players.find((x) => x.name === name);
      return p ? { me: p.me, cls: p.class } : null;
    };
    const colorOf = (name) => {
      const p = players.find((x) => x.name === name);
      return (p && COLORS[p.class]) || "#8892a6";
    };
    legend.replaceChildren();
    for (const p of s.players) {
      const l = el("span", "hLeg");
      const sw = el("i");
      sw.style.background = colorOf(p.name);
      l.append(sw, doc.createTextNode(nm(p.name, playerInfo(p.name))));
      legend.append(l);
    }
    if (s.boss.length) {
      const l = el("span", "hLeg boss");
      l.append(el("i"), doc.createTextNode("Vida do boss (%)"));
      legend.append(l);
    }
    const w = Math.max(320, Math.round(card.clientWidth - 34) || 600);
    chart(cv, s, colorOf, w, 240, 2);
    curReplay = { box: replayBox, f, nm };
    replay(replayBox, f, nm, w, start);
    if (same && scroller) scroller.scrollTop = top;
  }

  // ---- "Linha do tempo": the replay of one fight -------------------------------
  const KIND_COLOR = { mech: "#ffd84d", bingo: "#4ea3f5", stagger: "#b48cff", death: "#ff6b62", revive: "#5fd38a" };
  const KIND_NAME = { mech: "Mecânica", bingo: "Bingo", stagger: "Stagger quebrado", death: "Morte", revive: "Voltou" };
  // Which lane of the strip above the HP line each kind goes in.
  const LANE = { mech: 0, bingo: 0, stagger: 1, revive: 1, death: 2 };
  // Pauses the replay shown; returns { id, t, playing } (null: none), so a
  // redraw can carry on from the same moment.
  let stopReplay = () => null;
  let curReplay = null; // { box, f, nm } of the open fight
  let replayRO = null; // the replay's ResizeObserver
  // The open fight's replay again (a marker switch changed), same moment.
  function redrawReplay() {
    if (!curReplay || !curReplay.box.isConnected) return;
    const st = stopReplay();
    const { box, f, nm } = curReplay;
    replay(box, f, nm, box.clientWidth || 600, st && st.id === f.id ? st : null);
  }
  // "Passe o mouse..." is shown until the first marker hover, once per PC.
  const TIP_KEY = "ludra:histTipSeen";
  let tipSeen = false;
  try {
    tipSeen = localStorage.getItem(TIP_KEY) === "1";
  } catch {}
  // Play/pause as two small drawn icons (the ⏸ character shows as a colour
  // emoji on Windows, next to a plain ▶).
  const ICON_PLAY = '<svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><path d="M1 1l9 5-9 5z" fill="currentColor"/></svg>';
  const ICON_PAUSE = '<svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><rect x="1" y="1" width="3.2" height="10" fill="currentColor"/><rect x="6.8" y="1" width="3.2" height="10" fill="currentColor"/></svg>';
  const setPlayBtn = (b, playing) => {
    b.innerHTML = `${playing ? ICON_PAUSE : ICON_PLAY}<span>${playing ? "Pausar" : "Play"}</span>`;
  };

  function replay(box, f, nm, W, start) {
    if (replayRO) replayRO.disconnect();
    replayRO = null;
    stopReplay = () => null;
    box.replaceChildren();
    if (!hasReplay(f)) {
      box.append(el("p", "note", opts.timeline ? "Essa luta não tem linha do tempo: foi salva antes dessa função existir, ou com ela desligada. As próximas lutas já vêm com ela." : "A linha do tempo está desligada (Opções do histórico, no topo desta aba). Ligue para as próximas lutas virem com ela."));
      return;
    }
    const t1 = Math.max(1000, replayEnd(f));
    const all = marksOf(f);
    const kinds = shownKinds(opts);
    const marks = all.filter((m) => kinds.includes(m.kind));
    const wrap = el("div", "hTl");
    const cv = el("canvas", "hTlChart");
    const tip = el("div", "hTip");
    tip.hidden = true;
    wrap.append(cv, tip);
    // The play bar.
    const bar = el("div", "hPlay");
    const play = el("button", "btn primary hPlayBtn");
    play.type = "button";
    setPlayBtn(play, false);
    const seek = el("input", "hSeek");
    seek.type = "range";
    seek.min = "0";
    seek.max = String(t1);
    seek.step = "250";
    seek.value = "0";
    seek.setAttribute("aria-label", "Momento da luta");
    const clock = el("span", "hClock", "");
    const speed = el("select", "hSpeedNow");
    speed.title = "Velocidade";
    for (const v of SPEEDS) {
      const o = el("option", "", `${v}x`);
      o.value = String(v);
      speed.append(o);
    }
    speed.value = String(opts.speed);
    bar.append(play, seek, clock, speed);
    // What was going on at that moment.
    const now = el("div", "hNow");
    const legend = el("div", "hLegend hTlLegend");
    const counts = {};
    for (const m of marks) counts[m.kind] = (counts[m.kind] || 0) + 1;
    for (const k of Object.keys(KIND_COLOR)) {
      if (!counts[k]) continue;
      const l = el("span", "hLeg");
      const sw = el("i", "dot");
      sw.style.background = KIND_COLOR[k];
      l.append(sw, doc.createTextNode(`${KIND_NAME[k]} (${counts[k]})`));
      legend.append(l);
    }
    const hiddenN = all.length - marks.length;
    if (hiddenN > 0) legend.append(el("span", "note hHid", `${hiddenN} marcador${hiddenN > 1 ? "es" : ""} escondido${hiddenN > 1 ? "s" : ""} (Opções do histórico)`));
    const optBtn = el("button", "btn hTlOpts", "Opções");
    optBtn.type = "button";
    optBtn.title = "Escolher o que aparece na linha do tempo";
    optBtn.addEventListener("click", openOpts);
    legend.append(optBtn);
    box.append(wrap, legend, bar, now);
    if (!f.hp || f.hp.length < 2) box.append(el("p", "note", "Sem a vida do boss nessa luta: só os marcadores."));
    const help = el("p", "note sub hTlHelp", "Passe o mouse (ou toque) num marcador para ver o que foi. Clique na linha para ir para aquele momento.");
    help.hidden = tipSeen;
    box.append(help);

    // The canvas is drawn at the box's width (sharp at any window size) and
    // drawn again when the box changes width.
    W = Math.max(200, Math.round(box.clientWidth) || W || 600);
    const H = 220, S = 2;
    let t = Math.max(0, Math.min(t1, Number(start && start.t) || 0));
    let pinned = null; // the marker whose details stay open (a tap)
    let hits = []; // where each marker was drawn: { x, y, m }
    const draw = () => (hits = drawReplay(cv, f, marks, t1, t, W, H, S));
    const fill = () => {
      seek.value = String(Math.round(t));
      clock.textContent = `${dur(t)} / ${dur(t1)}`;
      const hp = hpAt(f.hp, t);
      const last = lastMech(all, t);
      const life = aliveAt(f, t);
      const total = life.alive.length + life.dead.length;
      now.replaceChildren();
      const cell = (label, value, cls) => {
        const c = el("div", `hNowCell${cls ? ` ${cls}` : ""}`);
        c.append(el("span", "hNowLabel", label), el("b", "", value));
        return c;
      };
      now.append(
        cell("Vida do boss", hp != null ? pctText(hp) : "—"),
        cell("Última mecânica", last ? `${last.title || KIND_NAME[last.kind]} (${dur(last.t)})` : "—"),
        cell("Vivos", total ? `${life.alive.length} de ${total}` : "—", life.dead.length ? "bad" : ""),
      );
      if (life.dead.length) {
        const who = life.dead.map((n) => {
          const p = (f.players || []).find((x) => x.name === n) || (f.deaths || []).find((x) => x.name === n) || {};
          return nm(n, { me: !!p.me, cls: p.class });
        });
        now.append(el("div", "hNowDead", `☠ Caídos: ${who.join(", ")}`));
      }
    };
    const showTip = (m, x, y) => {
      if (!m) {
        tip.hidden = true;
        return;
      }
      const w = markText(m, nm);
      tip.replaceChildren(el("b", "", w.head));
      for (const line of String(w.body || "").split("\n").filter(Boolean)) tip.append(el("div", "", line));
      tip.style.setProperty("--c", KIND_COLOR[m.kind] || "#fff");
      tip.hidden = false;
      if (!tipSeen) {
        tipSeen = true;
        help.hidden = true;
        try {
          localStorage.setItem(TIP_KEY, "1");
        } catch {}
      }
      // Inside the chart, left of the marker when near the right edge. The
      // canvas may show smaller than W x H until it is drawn again: scaled.
      const r = cv.getBoundingClientRect();
      const kx = (r.width || W) / W, ky = (r.height || H) / H;
      const cw = W * kx;
      const tw = Math.min(260, cw - 8);
      tip.style.left = `${Math.max(4, Math.min(cw - tw - 4, x * kx - tw / 2))}px`;
      tip.style.top = `${y * ky + 14}px`;
      tip.style.maxWidth = `${tw}px`;
    };
    const go = (v) => {
      t = Math.max(0, Math.min(t1, v));
      draw();
      fill();
    };
    const hitAt = (ev) => {
      const r = cv.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / (r.width || W)) * W;
      const y = ((ev.clientY - r.top) / (r.height || H)) * H;
      let best = null;
      for (const h of hits) {
        const d = Math.hypot(h.x - x, h.y - y);
        if (d <= 9 && (!best || d < best.d)) best = { ...h, d };
      }
      return { x, y, best };
    };
    cv.addEventListener("pointermove", (ev) => {
      if (pinned) return;
      const { best } = hitAt(ev);
      cv.style.cursor = best ? "pointer" : "crosshair";
      showTip(best && best.m, best && best.x, best && best.y);
    });
    cv.addEventListener("pointerleave", () => !pinned && showTip(null));
    cv.addEventListener("click", (ev) => {
      const { x, best } = hitAt(ev);
      if (best) {
        // A tap on a marker: its details stay, and the replay goes there.
        pinned = pinned === best.m ? null : best.m;
        showTip(pinned, best.x, best.y);
        go(best.m.t);
        return;
      }
      pinned = null;
      showTip(null);
      const L = PLOT.L, pw = W - PLOT.L - PLOT.R;
      if (x >= L - 4 && x <= L + pw + 4) go(((x - L) / pw) * t1);
    });
    seek.addEventListener("input", () => {
      pinned = null;
      showTip(null);
      go(Number(seek.value));
    });
    // Play: the fight at `speed` times its pace. Paused when it cannot be
    // seen (another pane, the window in the tray), so it does not keep drawing.
    let raf = 0, lastFrame = 0;
    const frame = (ts) => {
      if (!box.isConnected || pane.hidden || doc.hidden) return pause();
      const dt = lastFrame ? ts - lastFrame : 0;
      lastFrame = ts;
      go(t + dt * opts.speed);
      if (t >= t1) return pause();
      raf = root.requestAnimationFrame(frame);
    };
    const pause = () => {
      if (raf) root.cancelAnimationFrame(raf);
      raf = 0;
      lastFrame = 0;
      setPlayBtn(play, false);
    };
    const begin = () => {
      if (t >= t1) go(0);
      pinned = null;
      showTip(null);
      setPlayBtn(play, true);
      raf = root.requestAnimationFrame(frame);
    };
    play.addEventListener("click", () => (raf ? pause() : begin()));
    speed.addEventListener("change", () => {
      setOpt("speed", Number(speed.value));
      if (optUi && optUi.speed) optUi.speed.value = speed.value;
    });
    stopReplay = () => {
      const playing = !!raf;
      pause();
      return { id: f.id, t, playing };
    };
    if (root.ResizeObserver) {
      const ro = new root.ResizeObserver(() => {
        if (!cv.isConnected) return ro.disconnect();
        const w = Math.round(box.clientWidth);
        if (w >= 200 && w !== W) {
          W = w;
          pinned = null;
          showTip(null);
          draw();
        }
      });
      ro.observe(box);
      replayRO = ro;
    }
    go(t);
    if (start && start.playing && t < t1 && !pane.hidden) begin();
  }

  const PLOT = { L: 44, R: 14, LANES: 3, LANE_H: 15, Tp: 6, B: 24 };
  // The replay's canvas: the marker strip on top (mechanics, stagger and
  // revives, deaths), the boss's HP below, the moment `cur` as a line.
  // Returns where each marker was drawn, for the mouse.
  function drawReplay(cv, f, marks, t1, cur, W, H, S) {
    cv.width = W * S;
    cv.height = H * S;
    // Only the width: CSS height:auto keeps the shape when max-width shrinks it.
    cv.style.width = `${W}px`;
    const g = cv.getContext("2d");
    if (!g) return [];
    g.setTransform(S, 0, 0, S, 0, 0);
    g.fillStyle = "#0f1217";
    g.fillRect(0, 0, W, H);
    const { L, R: Rm, LANES, LANE_H, Tp, B } = PLOT;
    const top = Tp + LANES * LANE_H + 6;
    const pw = W - L - Rm, ph = H - top - B;
    const x = (t) => L + (Math.max(0, Math.min(t1, t)) / t1) * pw;
    const y = (p) => top + ph - (p / 100) * ph;
    g.font = "11px Segoe UI, sans-serif";
    // The strip's lanes.
    for (let i = 0; i < LANES; i++) {
      g.fillStyle = i % 2 ? "rgba(255,255,255,.02)" : "rgba(255,255,255,.04)";
      g.fillRect(L, Tp + i * LANE_H, pw, LANE_H);
    }
    // HP grid.
    g.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const yy = top + (ph * i) / 4;
      g.strokeStyle = "rgba(255,255,255,.07)";
      g.beginPath();
      g.moveTo(L, yy);
      g.lineTo(L + pw, yy);
      g.stroke();
      g.fillStyle = "#8b93a3";
      g.textAlign = "right";
      g.fillText(`${100 - i * 25}%`, L - 6, yy);
    }
    g.textAlign = "center";
    g.textBaseline = "top";
    const steps = Math.min(6, Math.max(1, Math.floor(t1 / 30000)));
    for (let i = 0; i <= steps; i++) {
      const tt = (t1 * i) / steps;
      g.fillStyle = "#8b93a3";
      g.fillText(dur(tt), x(tt), top + ph + 6);
    }
    // Faint lines down from each marker, so a mechanic lines up with the HP.
    for (const m of marks) {
      g.strokeStyle = (KIND_COLOR[m.kind] || "#fff") + "33";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x(m.t), Tp + LANES * LANE_H);
      g.lineTo(x(m.t), top + ph);
      g.stroke();
    }
    // The HP line: what has been played brighter than what is to come.
    const hp = f.hp || [];
    if (hp.length > 1) {
      const path = (to) => {
        g.beginPath();
        let started = false;
        for (const [tt, v] of hp) {
          if (tt > to) break;
          if (!started) g.moveTo(x(tt), y(v));
          else g.lineTo(x(tt), y(v));
          started = true;
        }
        return started;
      };
      g.lineWidth = 2;
      g.lineJoin = "round";
      g.strokeStyle = "rgba(255,107,98,.35)";
      if (path(Infinity)) g.stroke();
      g.strokeStyle = "#ff6b62";
      if (path(cur)) {
        const v = hpAt(hp, cur);
        if (v != null) g.lineTo(x(cur), y(v));
        g.stroke();
      }
    }
    // The markers.
    const out = [];
    for (const m of marks) {
      const mx = x(m.t);
      const my = Tp + (LANE[m.kind] ?? 0) * LANE_H + LANE_H / 2;
      const c = KIND_COLOR[m.kind] || "#fff";
      g.globalAlpha = m.t <= cur ? 1 : 0.55;
      g.fillStyle = c;
      g.beginPath();
      if (m.kind === "death") {
        g.arc(mx, my, 4.5, 0, Math.PI * 2);
      } else if (m.kind === "stagger") {
        g.moveTo(mx, my - 5);
        g.lineTo(mx + 5, my + 4);
        g.lineTo(mx - 5, my + 4);
        g.closePath();
      } else if (m.kind === "revive") {
        g.rect(mx - 1.5, my - 5, 3, 10);
        g.rect(mx - 5, my - 1.5, 10, 3);
      } else {
        const r = m.kind === "bingo" ? 6 : 4.5;
        g.moveTo(mx, my - r);
        g.lineTo(mx + r, my);
        g.lineTo(mx, my + r);
        g.lineTo(mx - r, my);
        g.closePath();
      }
      g.fill();
      g.globalAlpha = 1;
      out.push({ x: mx, y: my, m });
    }
    // The moment.
    g.strokeStyle = "#fff";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x(cur), Tp);
    g.lineTo(x(cur), top + ph);
    g.stroke();
    const v = hpAt(hp, cur);
    if (v != null && hp.length > 1) {
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(x(cur), y(v), 3.5, 0, Math.PI * 2);
      g.fill();
    }
    return out;
  }

  // "Esconder nomes" (names.js): a saved fight is numbered by its own table,
  // highest damage first. Only the text drawn; the saved fight keeps the names.
  // The page follows "Onde esconder" ("app"); the copied image goes to
  // Discord or a live, so it follows the main switch alone ("game").
  const plain = (n) => n;
  const namesOf = (players, scope = "app") => (root.LudraNames ? root.LudraNames.list(players, scope) : plain);

  // The chart on a canvas: DPS on the left axis, the boss's HP % (dashed) on the right.
  function chart(cv, s, colorOf, W, H, S) {
    cv.width = W * S;
    cv.height = H * S;
    // Only the width: CSS height:auto keeps the shape on a narrow window.
    cv.style.width = `${W}px`;
    const g = cv.getContext("2d");
    g.scale(S, S);
    g.fillStyle = "#0f1217";
    g.fillRect(0, 0, W, H);
    const L = 56, Rm = 40, Tp = 10, B = 26;
    const pw = W - L - Rm, ph = H - Tp - B;
    if (!s.players.length && !s.boss.length) {
      g.fillStyle = "#8b93a3";
      g.font = "13px Segoe UI, sans-serif";
      g.fillText("Sem dados de tempo nessa luta.", L, Tp + ph / 2);
      return;
    }
    const top = niceTop(s.top);
    const t1 = Math.max(1, s.t1);
    const x = (t) => L + (t / t1) * pw;
    const yD = (v) => Tp + ph - (v / top) * ph;
    const yP = (p) => Tp + ph - (p / 100) * ph;
    g.font = "11px Segoe UI, sans-serif";
    g.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const y = Tp + (ph * i) / 4;
      g.strokeStyle = "rgba(255,255,255,.07)";
      g.beginPath();
      g.moveTo(L, y);
      g.lineTo(L + pw, y);
      g.stroke();
      g.fillStyle = "#8b93a3";
      g.textAlign = "right";
      g.fillText(num(top * (1 - i / 4)), L - 6, y);
      if (s.boss.length) {
        g.textAlign = "left";
        g.fillText(`${100 - i * 25}%`, L + pw + 6, y);
      }
    }
    g.textAlign = "center";
    g.textBaseline = "top";
    const steps = Math.min(6, Math.max(1, Math.floor(t1 / 30000)));
    for (let i = 0; i <= steps; i++) {
      const t = (t1 * i) / steps;
      g.fillStyle = "#8b93a3";
      g.fillText(dur(t), x(t), Tp + ph + 6);
    }
    g.lineWidth = 2;
    g.lineJoin = "round";
    for (const p of s.players) {
      g.strokeStyle = colorOf(p.name);
      g.beginPath();
      p.pts.forEach(([t, v], i) => (i ? g.lineTo(x(t), yD(v)) : g.moveTo(x(t), yD(v))));
      g.stroke();
    }
    if (s.boss.length) {
      g.strokeStyle = "#ff6b62";
      g.lineWidth = 1.5;
      g.setLineDash([6, 4]);
      g.beginPath();
      s.boss.forEach(([t, v], i) => (i ? g.lineTo(x(t), yP(v)) : g.moveTo(x(t), yP(v))));
      g.stroke();
      g.setLineDash([]);
    }
  }

  function askDelete(f, acts) {
    if (acts.querySelector(".hAsk")) return;
    const ask = el("div", "hAsk");
    const yes = el("button", "btn danger", "Sim, apagar");
    yes.type = "button";
    const no = el("button", "btn", "Cancelar");
    no.type = "button";
    ask.append(el("span", "", "Apagar essa luta do histórico? Não dá para desfazer."), yes, no);
    no.addEventListener("click", () => ask.remove());
    yes.addEventListener("click", async () => {
      try {
        await call("history_delete", { id: f.id });
      } catch {}
      open = null;
      stopReplay();
      curReplay = null;
      view.replaceChildren();
      refresh();
    });
    acts.after(ask);
  }

  // The image for the Discord: the players and the chart.
  async function copyImage(f, note) {
    const W = 640, PAD = 18, RH = 28, CH = 220;
    const players = (f.players || []).slice().sort((a, b) => b.dps - a.dps);
    const H = PAD + 52 + players.length * RH + 16 + CH + PAD;
    const nm = namesOf(players, "game");
    const S = 2;
    const cv = doc.createElement("canvas");
    cv.width = W * S;
    cv.height = H * S;
    const g = cv.getContext("2d");
    g.scale(S, S);
    g.fillStyle = "#0f1217";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#4ea3f5";
    g.fillRect(0, 0, W, 3);
    g.textBaseline = "middle";
    g.font = "700 20px Segoe UI, sans-serif";
    g.fillStyle = "#fff";
    g.fillText(f.boss || "Boss", PAD, PAD + 12);
    g.font = "600 13px Segoe UI, sans-serif";
    g.fillStyle = f.won ? "#5fd38a" : "#ff6b62";
    g.fillText(result(f).toUpperCase(), PAD, PAD + 36);
    g.fillStyle = "#8b93a3";
    g.textAlign = "right";
    g.fillText(`${when(f.id)} · ${dur(f.duration_ms)}`, W - PAD, PAD + 12);
    g.fillText("Ludra BR", W - PAD, PAD + 36);
    g.textAlign = "left";
    let y = PAD + 52;
    const topD = Math.max(1, ...players.map((p) => p.dps));
    players.forEach((p, i) => {
      const c = COLORS[p.class] || "#8892a6";
      g.fillStyle = "#171b22";
      g.fillRect(PAD, y + 2, W - PAD * 2, RH - 4);
      g.fillStyle = c + "55";
      g.fillRect(PAD, y + 2, (W - PAD * 2) * (p.dps / topD), RH - 4);
      g.fillStyle = c;
      g.fillRect(PAD, y + 2, 3, RH - 4);
      g.font = `${p.me ? 700 : 600} 14px Segoe UI, sans-serif`;
      g.fillStyle = "#fff";
      g.fillText(`${i + 1}. ${nm(p.name, { me: p.me, cls: p.class })}${p.deaths ? `  ☠${p.deaths}` : ""}`, PAD + 12, y + RH / 2);
      g.textAlign = "right";
      g.font = "700 14px Segoe UI, sans-serif";
      g.fillText(`${num(p.dps)}/s`, W - PAD - 10, y + RH / 2);
      g.textAlign = "left";
      y += RH;
    });
    y += 16;
    const c2 = doc.createElement("canvas");
    const colorOf = (name) => {
      const p = players.find((x) => x.name === name);
      return (p && COLORS[p.class]) || "#8892a6";
    };
    chart(c2, series(f.timeline), colorOf, W - PAD * 2, CH, S);
    g.drawImage(c2, PAD, y, W - PAD * 2, CH);
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      note.textContent = "Copiado. Cole no Discord (Ctrl+V).";
    } catch {
      const a = doc.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ludra-historico-${f.id}.png`;
      a.click();
      note.textContent = "Imagem salva em Downloads.";
    }
  }

  filter && filter.addEventListener("change", renderList);
  // Open the tab: read the list again.
  const tab = doc.querySelector('.tab[data-tab="hist"]');
  tab && tab.addEventListener("click", () => refresh());
  // Another pane, or the window hidden (tray): the replay pauses.
  for (const t of doc.querySelectorAll(".tab")) if (t !== tab) t.addEventListener("click", () => stopReplay());
  doc.addEventListener("visibilitychange", () => doc.hidden && stopReplay());
  if (T && T.event) {
    T.event.listen("new-best", (e) => {
      const b = e.payload || {};
      root.ludraCall?.(bestCall(b));
      refresh();
    });
    // A fight saved by the backend shows up without reopening the tab, and
    // gets the mechanics this page called during it (its "Linha do tempo").
    T.event.listen("history-saved", async (e) => {
      const id = Number(e.payload) || 0;
      if (id && opts.timeline) {
        try {
          const f = await call("history_get", { id });
          const marks = collectMarks(root.ludraLog ? root.ludraLog() : [], f, root.LUDRA_BR && root.LUDRA_BR.bosses);
          if (f && marks.length) await call("history_marks", { id, marks });
        } catch (err) {
          console.warn("history_marks", err);
        }
      }
      refresh();
      if (open && open.id === id) show(id);
    });
  }
  refresh();
  // "Esconder nomes" turned on or off: the open fight again.
  root.LudraNames?.onChange(() => open && show(open.id));
  root.__historyTest = { refresh, show, setDemo: (v) => (demo = v) };
})(typeof window !== "undefined" ? window : globalThis);
