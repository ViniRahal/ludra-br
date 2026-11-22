// "Histórico": every boss fight the program saved on this PC (the backend's
// history_list / history_get / history_delete / history_bests), the DPS of
// each player over the fight on a chart with the boss's HP, your skills, and
// your records per boss. A new record is called on the big text.
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
  const demoGet = (id) => {
    const f = DEMO.find((x) => x.id === id);
    if (!f) return null;
    return {
      ...f,
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

  root.LudraHistory = { num, dur, result, when, bestCall, series, niceTop, bossesOf, demoGet, DEMO, DEMO_BESTS };

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

  async function show(id) {
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
    if (!players.length) card.append(el("p", "note", "O medidor não pegou dano nessa luta."));
    players.forEach((p, i) => {
      const row = el("div", `fRow${p.me ? " me" : ""}`);
      row.style.setProperty("--c", COLORS[p.class] || "#8892a6");
      row.append(el("span", "fPos", `${i + 1}`), icon(p.class), el("span", "fName", p.name), el("span", "fTotal", num(p.total)), el("span", "fDps", `${num(p.dps)}/s`), el("span", "fDead", p.deaths ? `☠ ${p.deaths}` : ""));
      card.append(row);
    });

    // The chart.
    card.append(el("h3", "hH", "DPS ao longo da luta"));
    const cv = el("canvas", "hChart");
    card.append(cv);
    const legend = el("div", "hLegend");
    card.append(legend);

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
    const colorOf = (name) => {
      const p = players.find((x) => x.name === name);
      return (p && COLORS[p.class]) || "#8892a6";
    };
    legend.replaceChildren();
    for (const p of s.players) {
      const l = el("span", "hLeg");
      const sw = el("i");
      sw.style.background = colorOf(p.name);
      l.append(sw, doc.createTextNode(p.name));
      legend.append(l);
    }
    if (s.boss.length) {
      const l = el("span", "hLeg boss");
      l.append(el("i"), doc.createTextNode("Vida do boss (%)"));
      legend.append(l);
    }
    const w = Math.max(320, Math.round(card.clientWidth - 34) || 600);
    chart(cv, s, colorOf, w, 240, 2);
  }

  // The chart on a canvas: DPS on the left axis, the boss's HP % (dashed) on the right.
  function chart(cv, s, colorOf, W, H, S) {
    cv.width = W * S;
    cv.height = H * S;
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
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
      g.fillText(`${i + 1}. ${p.name}${p.deaths ? `  ☠${p.deaths}` : ""}`, PAD + 12, y + RH / 2);
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
  if (T && T.event) {
    T.event.listen("new-best", (e) => {
      const b = e.payload || {};
      root.ludraCall?.(bestCall(b));
      refresh();
    });
    // A fight saved by the backend shows up without reopening the tab.
    T.event.listen("history-saved", () => refresh());
  }
  refresh();
  root.__historyTest = { refresh, show, setDemo: (v) => (demo = v) };
})(typeof window !== "undefined" ? window : globalThis);
