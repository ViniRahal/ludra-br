// "Resumo das lutas": at the end of each fight with a Ludra boss (killed or a
// wipe), a card with each player's DPS (highest first), the deaths,
// and the mechanics as they came. The card can be copied as an image for the
// Discord.
(function () {
  const K = window.meterKit;
  if (!K) return;
  const { COLORS, short, clock, icon, el } = K;
  const T = window.__TAURI__;
  const STORE = "ludra:fights";
  const KEEP = 15;
  const MIN_WIPE_MS = 30_000; // a wipe shorter than this: a bad pull, not kept

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
      localStorage.setItem(STORE, JSON.stringify(fights.slice(0, KEEP)));
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
    if (!won && dur < MIN_WIPE_MS) return;
    const rows = ((lastView && lastView.rows) || []).map((r) => ({ name: r.name, class: r.class, dps: r.dps, total: r.total, deaths: r.deaths || 0, me: !!r.me })).sort((a, b) => b.dps - a.dps);
    const mechs = (window.ludraLog?.() || [])
      .filter((e) => e.boss === f.key && e.at >= f.pullAt - 2000 && e.what && !/^(skill|efeito) /.test(String(e.what.title || "")))
      .map((e) => ({ t: e.at - f.pullAt, title: `${e.what.title}${e.what.n > 1 ? ` ${e.what.n}` : ""}`, pct: e.pct }));
    const deaths = (window.ludraDeaths || []).filter((d) => d.pull === f.pullAt).map((d) => ({ t: d.at - f.pullAt, name: d.name, mech: d.mech }));
    if (!rows.length && !mechs.length) return; // nothing seen of it
    fights.unshift({ id: f.pullAt, key: f.key, name: f.name, at: Date.now(), dur, won, low: Math.round(f.low * 10) / 10, rows, mechs, deaths });
    fights = fights.slice(0, KEEP);
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
    if (s.cur <= 0 && s.pct != null && !fight.done) {
      const f = fight;
      setTimeout(() => end(f, true), 1500); // the last hits reach the meter
      f.killed = true;
    }
  };

  // ---- the page ------------------------------------------------------------

  const list = document.querySelector(".fights");
  const when = (at) => new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  function card(f) {
    const c = el("div", `card fight${f.won ? " won" : " wipe"}`);
    const head = el("div", "fHead");
    const title = el("div", "fTitle");
    title.append(el("b", "", f.name), el("span", `fRes ${f.won ? "won" : "wipe"}`, f.won ? "Derrotado" : `Wipe em ${String(f.low).replace(".", ",")}%`));
    const meta = el("div", "fMeta", `${when(f.at)} · ${clock(f.dur)}`);
    head.append(title, meta);
    c.append(head);
    if (!f.rows.length) c.append(el("p", "note", "O medidor não pegou dano nessa luta."));
    const ranked = f.rows.slice().sort((a, b) => b.dps - a.dps);
    ranked.forEach((r, i) => {
      const row = el("div", `fRow${r.me ? " me" : ""}`);
      row.style.setProperty("--c", COLORS[r.class] || "#8892a6");
      row.append(
        el("span", "fPos", `${i + 1}`),
        icon(r.class),
        el("span", "fName", r.name),
        el("span", "fTotal", short(r.total)),
        el("span", "fDps", `${short(r.dps)}/s`),
        el("span", "fDead", r.deaths ? `☠ ${r.deaths}` : ""),
      );
      c.append(row);
    });
    if (f.deaths && f.deaths.length) {
      const d = el("div", "fDeaths");
      d.append(el("b", "", `☠ Mortes (${f.deaths.length}): `));
      d.append(document.createTextNode(f.deaths.map((x) => `${clock(x.t)} ${x.name}${x.mech ? ` (${x.mech})` : ""}`).join(" · ")));
      c.append(d);
    }
    if (f.mechs.length) {
      const m = el("div", "fMechs");
      for (const x of f.mechs.slice(0, 30)) m.append(el("span", "fMech", `${clock(x.t)} ${x.title}${x.pct != null ? ` (${String(x.pct).replace(".", ",")}%)` : ""}`));
      c.append(m);
    }
    const acts = el("div", "fActs");
    const copy = el("button", "btn", "Copiar imagem");
    copy.type = "button";
    const note = el("span", "note fNote", "");
    copy.addEventListener("click", () => copyImage(f, note));
    acts.append(copy, note);
    c.append(acts);
    return c;
  }

  function render() {
    if (!list) return;
    list.replaceChildren();
    if (!fights.length) {
      list.append(el("p", "note", "Nenhuma luta ainda. Quando um boss do Ludra morrer (ou a PT der wipe), o resumo aparece aqui."));
      return;
    }
    for (const f of fights) list.append(card(f));
  }

  // ---- the image for the Discord --------------------------------------------

  function draw(f) {
    const W = 620, RH = 30, PAD = 18;
    const mechLines = Math.ceil(Math.min(f.mechs.length, 30) / 3);
    const H = PAD + 52 + f.rows.length * RH + (mechLines ? 14 + mechLines * 20 : 0) + PAD;
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
    g.fillText(f.name, PAD, PAD + 12);
    g.font = "600 13px Segoe UI, sans-serif";
    g.fillStyle = f.won ? "#5fd38a" : "#ff6b62";
    const res = f.won ? "DERROTADO" : `WIPE EM ${String(f.low).replace(".", ",")}%`;
    g.fillText(res, PAD, PAD + 36);
    g.fillStyle = "#8b93a3";
    g.textAlign = "right";
    g.fillText(`${when(f.at)} · ${clock(f.dur)}`, W - PAD, PAD + 12);
    g.fillText("Ludra BR", W - PAD, PAD + 36);
    g.textAlign = "left";
    let y = PAD + 52;
    const top = Math.max(1, ...f.rows.map((r) => r.dps));
    const ranked = f.rows.slice().sort((a, b) => b.dps - a.dps);
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
      g.fillText(`${i + 1}. ${r.name}` + (r.deaths ? `  ☠${r.deaths}` : ""), PAD + 12, y + RH / 2);
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

  render();
  window.__fightsTest = { end, draw, fights: () => fights, setView: (v) => (lastView = v) };
})();
