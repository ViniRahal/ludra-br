// "Resumo das lutas": at the end of each fight with a Ludra boss (killed or a
// wipe), a card with each player's DPS (highest first), the deaths,
// and the mechanics as they came. The card can be copied as an image for the
// Discord.
(function () {
  const K = window.meterKit;
  if (!K) return;
  const { COLORS, short, clock, icon, el } = K;
  const R = window.LudraRecap;
  // "12:31 Fulano — Raio em linha (85 mil, 2,1 s)", or the old "(mecânica)".
  // nm: the names to draw ("Esconder nomes"); the saved fight keeps the real ones.
  const deathText = (x, nm) => {
    if (nm) x = { ...x, name: nm(x.name), kill: x.kill ? { ...x.kill, killer: nm.text(x.kill.killer) } : x.kill };
    return R ? R.summary(x) : `${clock(x.t)} ${x.name}${x.mech ? ` (${x.mech})` : ""}`;
  };
  // "Esconder nomes" (names.js): each fight keeps the numbers its players had
  // on the live meter (end() saves them), so "Jogador 1" on the Resumo is the
  // same player as on the meter. The card follows "Onde esconder" ("app");
  // the copied image goes to Discord or a live, so it follows the main
  // switch alone ("game").
  const plain = Object.assign((n) => n, { text: (n) => n });
  const namesOf = (ranked, scope = "app") => (window.LudraNames ? window.LudraNames.list(ranked, scope) : plain);
  const T = window.__TAURI__;
  const STORE = "ludra:fights";
  const MIN_WIPE_MS = 30_000; // a wipe shorter than this: a bad pull, not kept
  // "Opções do resumo": how many cards to keep (15 as before), and the wipes.
  const opt = (k, d) => {
    try {
      const v = localStorage.getItem(`ludra:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  };
  const setOpt = (k, v) => {
    try {
      localStorage.setItem(`ludra:${k}`, JSON.stringify(v));
    } catch {}
  };
  let keepN = Math.max(1, Number(opt("fightsKeep", 15)) || 15);
  let keepWipes = opt("fightsWipes", true) !== false;
  const keep = () => keepN;

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE)) || [];
    } catch {
      return [];
    }
  };
  let fights = load();
  const save = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify(fights.slice(0, keep())));
    } catch {}
  };

  // The meter's last table with damage in it: the fight's numbers.
  let lastView = null;
  T && T.event.listen("meter", (e) => {
    const v = e.payload;
    if (v && v.rows && v.rows.length) lastView = v;
  });

  let fight = null; // { key, name, pullAt, low, done }
  function end(f, won) {
    if (f.done) return;
    f.done = true;
    won = won || !!f.killed;
    const dur = won && lastView && lastView.time_ms > 0 ? lastView.time_ms : Date.now() - f.pullAt;
    if (!won && (dur < MIN_WIPE_MS || !keepWipes)) return;
    // no/cno: the player's numbers on the live meter ("Esconder nomes"); the
    // names saved are the real ones.
    const N = window.LudraNames;
    const rows = ((lastView && lastView.rows) || []).map((r) => ({ id: r.id, name: r.name, class: r.class, dps: r.dps, total: r.total, deaths: r.deaths || 0, me: !!r.me, ...((N && N.numbers(r.name, r.id)) || {}) })).sort((a, b) => b.dps - a.dps);
    const mechs = (window.ludraLog?.() || [])
      .filter((e) => e.boss === f.key && e.at >= f.pullAt - 2000 && e.what && !/^(skill|efeito) /.test(String(e.what.title || "")))
      .map((e) => ({ t: e.at - f.pullAt, title: `${e.what.title}${e.what.n > 1 ? ` ${e.what.n}` : ""}`, pct: e.pct }));
    const deaths = (window.ludraDeaths || []).filter((d) => d.pull === f.pullAt).map((d) => ({ t: d.at - f.pullAt, name: d.name, mech: d.mech, kill: d.kill || null }));
    if (!rows.length && !mechs.length) return; // nothing seen of it
    fights.unshift({ id: f.pullAt, key: f.key, name: f.name, diff: f.diff || null, at: Date.now(), dur, won, low: Math.round(f.low * 10) / 10, rows, mechs, deaths });
    fights = fights.slice(0, keep());
    save();
    render();
    lastView = null;
  }

  window.onBossState = (s) => {
    if (fight && (!s || s.key !== fight.key || s.pullAt !== fight.pullAt)) {
      end(fight, false);
      fight = null;
    }
    if (!s || !s.key || !s.pullAt) return;
    if (!fight) fight = { key: s.key, name: s.name, pullAt: s.pullAt, low: 100, done: false };
    if (s.pct != null) fight.low = Math.min(fight.low, s.pct);
    if (s.diff) fight.diff = s.diff;
    if (s.cur <= 0 && s.pct != null && !fight.done) {
      const f = fight;
      setTimeout(() => end(f, true), 1500); // the last hits reach the meter
      f.killed = true;
    }
  };

  // ---- the page ------------------------------------------------------------

  const list = document.querySelector(".fights");
  const when = (at) => new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  const pctTxt = (v) => String(Math.round(v * 10) / 10).replace(".", ",");
  const diffTxt = (f) => (f.diff ? (f.diff === "hard" ? "Hard" : "Normal") : "");
  const resTxt = (f) => (f.won ? "Derrotado" : `Wipe com ${pctTxt(f.low)}% de vida`);
  const stat = (label, value) => {
    const t = el("div", "fStat");
    t.append(el("span", "fStatV", value), el("span", "fStatL", label));
    return t;
  };

  // One fight: a line with the boss, the result and the time (a click opens
  // it), and inside: the numbers of the fight, each player with a bar of
  // the DPS, the deaths and the mechanics.
  function card(f, open) {
    const c = el("details", `card fight${f.won ? " won" : " wipe"}`);
    c.open = !!open;
    const head = el("summary", "fHead");
    const title = el("div", "fTitle");
    const nameLine = el("div", "fNameLine");
    nameLine.append(el("b", "", f.name));
    if (f.diff) nameLine.append(el("span", `fDiff ${f.diff}`, diffTxt(f)));
    nameLine.append(el("span", `fRes ${f.won ? "won" : "wipe"}`, resTxt(f)));
    title.append(nameLine, el("span", "fMeta", `${when(f.at)} · durou ${clock(f.dur)}`));
    head.append(title, el("span", "fChevron", "›"));
    c.append(head);
    const body = el("div", "fBody");
    c.append(body);
    const ranked = f.rows.slice().sort((a, b) => b.dps - a.dps);
    const teamDps = ranked.reduce((n, r) => n + (r.dps || 0), 0);
    const teamTotal = ranked.reduce((n, r) => n + (r.total || 0), 0);
    const deathsN = (f.deaths && f.deaths.length) || ranked.reduce((n, r) => n + (r.deaths || 0), 0);
    const stats = el("div", "fStats");
    stats.append(stat("Duração", clock(f.dur)), stat("DPS da party", ranked.length ? `${short(teamDps)}/s` : "—"), stat("Dano total", ranked.length ? short(teamTotal) : "—"), stat("Mortes", String(deathsN)));
    if (!f.won) stats.append(stat("Vida do boss no wipe", `${pctTxt(f.low)}%`));
    body.append(stats);
    if (!ranked.length) body.append(el("p", "note", "O medidor não pegou dano nessa luta."));
    else {
      const head2 = el("div", "fRowsHead");
      head2.append(el("span", "", "Jogador"), el("span", "", "% dano"), el("span", "", "Dano"), el("span", "", "DPS"));
      body.append(head2);
    }
    const nm = namesOf(ranked);
    const top = Math.max(1, ...ranked.map((r) => r.dps || 0));
    ranked.forEach((r, i) => {
      const row = el("div", `fRow${r.me ? " me" : ""}`);
      row.style.setProperty("--c", COLORS[r.class] || "#8892a6");
      row.style.setProperty("--w", `${Math.max(2, ((r.dps || 0) / top) * 100)}%`);
      const who = el("span", "fWho");
      who.append(el("span", "fPos", `${i + 1}`), icon(r.class), el("span", "fName", nm(r.name, { me: r.me, cls: r.class })));
      if (r.deaths) who.append(el("span", "fDead", `☠ ${r.deaths}`));
      row.append(who, el("span", "fShare", teamTotal ? `${Math.round(((r.total || 0) / teamTotal) * 100)}%` : ""), el("span", "fTotal", short(r.total)), el("span", "fDps", `${short(r.dps)}/s`));
      body.append(row);
    });
    if (f.deaths && f.deaths.length) {
      const d = el("div", "fSection fDeaths");
      d.append(el("div", "fSecHead", `☠ Mortes (${f.deaths.length})`));
      for (const x of f.deaths) d.append(el("div", "fDeath", deathText(x, nm)));
      body.append(d);
    }
    if (f.mechs.length) {
      const m = el("details", "fSection fMechBox");
      m.append(el("summary", "fSecHead", `Mecânicas na ordem (${f.mechs.length})`));
      const list = el("div", "fMechs");
      for (const x of f.mechs.slice(0, 40)) {
        const it = el("div", "fMech");
        it.append(el("span", "fMechT", clock(x.t)), el("span", "fMechN", x.title), el("span", "fMechP", x.pct != null ? `${pctTxt(x.pct)}%` : ""));
        list.append(it);
      }
      m.append(list);
      body.append(m);
    }
    const acts = el("div", "fActs");
    const copy = el("button", "btn primary", "Copiar imagem para o Discord");
    copy.type = "button";
    const del = el("button", "btn", "Apagar esta luta");
    del.type = "button";
    const note = el("span", "note fNote", "");
    copy.addEventListener("click", () => copyImage(f, note));
    let armed = 0;
    del.addEventListener("click", () => {
      if (!armed) {
        del.textContent = "Clique de novo para apagar";
        armed = setTimeout(() => ((armed = 0), (del.textContent = "Apagar esta luta")), 4000);
        return;
      }
      clearTimeout(armed);
      fights = fights.filter((x) => x !== f);
      save();
      render();
    });
    acts.append(copy, del, note);
    body.append(acts);
    return c;
  }

  function render() {
    if (!list) return;
    list.replaceChildren();
    if (!fights.length) {
      list.append(el("p", "note", "Nenhuma luta ainda. Quando um boss do Ludra morrer (ou a PT der wipe), o resumo aparece aqui."));
      return;
    }
    fights.forEach((f, i) => list.append(card(f, i === 0)));
  }

  // ---- the image for the Discord --------------------------------------------

  function draw(f) {
    const W = 620, RH = 30, PAD = 18;
    const mechLines = Math.ceil(Math.min(f.mechs.length, 30) / 3);
    const deathLines = Math.min((f.deaths || []).length, 10);
    const H = PAD + 52 + f.rows.length * RH + (deathLines ? 14 + 20 + deathLines * 19 : 0) + (mechLines ? 14 + mechLines * 20 : 0) + PAD;
    const cv = document.createElement("canvas");
    const S = 2;
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
    g.fillText(f.name + (f.diff ? ` · ${f.diff === "hard" ? "Hard" : "Normal"}` : ""), PAD, PAD + 12);
    g.font = "600 13px Segoe UI, sans-serif";
    g.fillStyle = f.won ? "#5fd38a" : "#ff6b62";
    const res = f.won ? "DERROTADO" : `WIPE EM ${String(f.low).replace(".", ",")}%`;
    const ranked0 = f.rows.slice().sort((a, b) => b.dps - a.dps);
    const tDps = ranked0.reduce((n, r) => n + (r.dps || 0), 0);
    const dN = (f.deaths && f.deaths.length) || ranked0.reduce((n, r) => n + (r.deaths || 0), 0);
    g.fillText(res, PAD, PAD + 36);
    const rw = g.measureText(res).width;
    g.fillStyle = "#aeb6c4";
    g.font = "13px Segoe UI, sans-serif";
    g.fillText(`·  DPS da party ${short(tDps)}/s  ·  ${dN} ${dN === 1 ? "morte" : "mortes"}`, PAD + rw + 10, PAD + 36);
    g.fillStyle = "#8b93a3";
    g.textAlign = "right";
    g.fillText(`${when(f.at)} · ${clock(f.dur)}`, W - PAD, PAD + 12);
    g.fillText("Ludra BR", W - PAD, PAD + 36);
    g.textAlign = "left";
    let y = PAD + 52;
    const top = Math.max(1, ...f.rows.map((r) => r.dps));
    const ranked = f.rows.slice().sort((a, b) => b.dps - a.dps);
    const nm = namesOf(ranked, "game");
    ranked.forEach((r, i) => {
      const c = COLORS[r.class] || "#8892a6";
      g.fillStyle = "#171b22";
      g.fillRect(PAD, y + 2, W - PAD * 2, RH - 4);
      g.fillStyle = c + "55";
      g.fillRect(PAD, y + 2, (W - PAD * 2) * (r.dps / top), RH - 4);
      g.fillStyle = c;
      g.fillRect(PAD, y + 2, 3, RH - 4);
      g.font = `${r.me ? 700 : 600} 14px Segoe UI, sans-serif`;
      g.fillStyle = "#fff";
      g.fillText(`${i + 1}. ${nm(r.name, { me: r.me, cls: r.class })}` + (r.deaths ? `  ☠${r.deaths}` : ""), PAD + 12, y + RH / 2);
      g.textAlign = "right";
      g.fillStyle = "#fff";
      g.font = "700 14px Segoe UI, sans-serif";
      g.fillText(`${short(r.dps)}/s`, W - PAD - 10, y + RH / 2);
      g.font = "13px Segoe UI, sans-serif";
      g.fillStyle = "#aeb6c4";
      g.fillText(short(r.total), W - PAD - 110, y + RH / 2);
      g.textAlign = "left";
      y += RH;
    });
    if (deathLines) {
      y += 14;
      g.font = "700 13px Segoe UI, sans-serif";
      g.fillStyle = "#ff8a80";
      g.fillText(`☠ Mortes (${f.deaths.length})`, PAD, y + 8);
      y += 20;
      g.font = "12px Segoe UI, sans-serif";
      g.fillStyle = "#e3c9c6";
      f.deaths.slice(0, deathLines).forEach((x, i) => g.fillText(deathText(x, nm), PAD + 6, y + i * 19 + 8, W - PAD * 2 - 6));
      y += deathLines * 19;
    }
    if (mechLines) {
      y += 14;
      g.font = "12px Segoe UI, sans-serif";
      g.fillStyle = "#aeb6c4";
      f.mechs.slice(0, 30).forEach((x, i) => {
        const col = i % 3, line = Math.floor(i / 3);
        g.fillText(`${clock(x.t)} ${x.title}${x.pct != null ? ` (${Math.round(x.pct)}%)` : ""}`, PAD + col * ((W - PAD * 2) / 3), y + line * 20 + 8);
      });
    }
    return cv;
  }

  async function copyImage(f, note) {
    const cv = draw(f);
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      note.textContent = "Copiado. Cole no Discord (Ctrl+V).";
    } catch {
      // No image clipboard: save the file instead.
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ludra-${f.key}-${f.id}.png`;
      a.click();
      note.textContent = "Imagem salva em Downloads.";
    }
  }

  {
    const wipes = document.querySelector(".fWipes"), keepSel = document.querySelector(".fKeep"), clear = document.querySelector(".fClear");
    if (wipes) {
      wipes.checked = keepWipes;
      wipes.addEventListener("change", () => setOpt("fightsWipes", (keepWipes = wipes.checked)));
    }
    if (keepSel) {
      keepSel.value = String(keepN);
      if (keepSel.value !== String(keepN)) keepSel.value = "15";
      keepSel.addEventListener("change", () => {
        keepN = Number(keepSel.value) || 15;
        setOpt("fightsKeep", keepN);
        fights = fights.slice(0, keepN);
        save();
        render();
      });
    }
    // Two clicks to clear: a slip of the mouse does not lose the cards.
    if (clear) {
      const LABEL = clear.textContent;
      let armed = 0;
      clear.addEventListener("click", () => {
        if (!armed) {
          clear.textContent = "Clique de novo para apagar";
          armed = setTimeout(() => ((armed = 0), (clear.textContent = LABEL)), 4000);
          return;
        }
        clearTimeout(armed);
        armed = 0;
        clear.textContent = LABEL;
        fights = [];
        save();
        render();
      });
    }
  }
  render();
  window.LudraNames?.onChange(render);
  window.__fightsTest = { end, draw, fights: () => fights, setView: (v) => (lastView = v) };
})();
