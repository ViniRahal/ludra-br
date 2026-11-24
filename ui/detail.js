// "Detalhe do jogador": click a player in the damage meter and see, as in
// the meters players know, each skill's damage, the crits, the biggest hit,
// what hit them and the healing. The numbers come from the program
// (`meter_detail`, the player's entity id), asked again once a second while
// the panel is open.
//
// The detail: { id, name, class, me, total, dps, time_ms, crit_pct, deaths,
//   skills: [{ id, name, total, hits, crit_pct, share, max, dps }],
//   taken, taken_by: [{ from, skill, total, hits }], heal_done, heal_received }
(function () {
  const T = window.__TAURI__;
  const kit = () => window.meterKit || {};
  const num = (n) => (window.LudraRecap ? window.LudraRecap.num(n) : String(Math.round(Number(n) || 0)));
  const pct = (n) => (Number(n) > 0 ? `${(Math.round(Number(n) * 10) / 10).toString().replace(".", ",")}%` : "—");
  const clock = (ms) => {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // Made-up detail for "Testar" (and when the program has none for a demo row).
  function demo(row) {
    const r = { id: 1, name: "Dark", class: "assassin", dps: 81100, total: 13.7e6, deaths: 0, me: false, ...(row || {}) };
    const parts = [["Golpe Rápido", 0.31, 412, 38], ["Lâmina Sombria", 0.22, 96, 52], ["Emboscada", 0.17, 41, 61], ["Corte Duplo", 0.12, 230, 33], ["Veneno", 0.08, 380, 0], ["Ataque básico", 0.06, 520, 29], ["Explosão Sombria", 0.04, 12, 75]];
    const skills = parts.map(([name, share, hits, crit], i) => {
      const total = r.total * share;
      return { id: 1000 + i, name, total, hits, crit_pct: crit, share: share * 100, max: (total / hits) * (crit ? 2.4 : 1.2), dps: r.dps * share };
    });
    return {
      id: r.id, name: r.name, class: r.class, me: !!r.me, total: r.total, dps: r.dps, time_ms: 169000, crit_pct: 41.3, deaths: r.deaths || 0,
      skills,
      taken: 612000,
      taken_by: [
        { from: "Ludra", skill: "Raio em linha", total: 255000, hits: 3 },
        { from: "Ludra", skill: "Cone", total: 164000, hits: 4 },
        { from: "Ludra", skill: "Anel roxo", total: 104000, hits: 4 },
        { from: "Ludra", skill: "Ataque básico", total: 89000, hits: 11 },
      ],
      heal_done: r.class === "cleric" || r.class === "chanter" ? 2.1e6 : 0,
      heal_received: 540000,
    };
  }

  let openId = null, openDemo = false, seed = null, timer = 0, back = null, panel = null;
  window.meterDetailDemo = false; // set by "Testar" while its fake meter shows

  function stat(label, value, cls) {
    const s = el("div", `dStat${cls ? ` ${cls}` : ""}`);
    s.append(el("span", "dLabel", label), el("b", "", value));
    return s;
  }

  function render(d) {
    const k = kit();
    panel.replaceChildren();
    const head = el("div", "dHead");
    const who = el("div", "dWho");
    who.style.setProperty("--c", (k.COLORS && k.COLORS[d.class]) || "#8892a6");
    if (k.icon) who.append(k.icon(d.class));
    const nm = el("div", "dName");
    // "Esconder nomes" (names.js): the name drawn; the detail keeps the real one.
    const N = window.LudraNames;
    const real = d.name || `#${d.id}`;
    nm.append(el("b", "", N ? N.name(real, { me: d.me, cls: d.class, id: d.id }, "app", openDemo || null) : real));
    const sub = [(k.NAMES && k.NAMES[d.class]) || "", d.me ? "você" : "", d.deaths > 0 ? `☠ ${d.deaths}` : ""].filter(Boolean).join(" · ");
    if (sub) nm.append(el("span", "", sub));
    who.append(nm);
    const x = el("button", "dClose", "✕");
    x.type = "button";
    x.title = "Fechar (Esc)";
    x.addEventListener("click", close);
    head.append(who, x);
    panel.append(head);

    const stats = el("div", "dStats");
    stats.append(stat("DPS", num(d.dps), "blue"), stat("Dano total", num(d.total)), stat("Crítico", pct(d.crit_pct)), stat("Tempo", d.time_ms > 0 ? clock(d.time_ms) : "—"));
    panel.append(stats);

    // Habilidades
    const skills = Array.isArray(d.skills) ? d.skills : [];
    panel.append(el("h3", "dH", "Habilidades"));
    if (!skills.length) panel.append(el("div", "dEmpty", "Nenhuma habilidade registrada ainda."));
    else {
      const t = el("div", "dTable dSkills");
      const h = el("div", "dRow dCols");
      for (const c of ["Habilidade", "Dano", "%", "Golpes", "Crítico", "Maior golpe"]) h.append(el("span", "", c));
      t.append(h);
      const top = Math.max(...skills.map((s) => Number(s.share) || 0), 1);
      for (const s of skills) {
        const r = el("div", "dRow");
        r.style.setProperty("--w", `${Math.max(1, ((Number(s.share) || 0) / top) * 100)}%`);
        r.style.setProperty("--c", (k.COLORS && k.COLORS[d.class]) || "#4ea3f5");
        r.append(el("span", "dSk", (s.name || "").trim() || `Habilidade ${s.id || "?"}`), el("span", "", num(s.total)), el("span", "", pct(s.share)), el("span", "", s.hits > 0 ? String(s.hits) : "—"), el("span", "", pct(s.crit_pct)), el("span", "", s.max > 0 ? num(s.max) : "—"));
        t.append(r);
      }
      panel.append(t);
    }

    // Dano recebido
    const taken = Array.isArray(d.taken_by) ? d.taken_by : [];
    const th = el("h3", "dH", "Dano recebido");
    if (d.taken > 0) th.append(el("span", "dHNum", num(d.taken)));
    panel.append(th);
    if (!taken.length) panel.append(el("div", "dEmpty", d.taken > 0 ? "Sem detalhe dos golpes." : "Não levou dano nesta luta."));
    else {
      const t = el("div", "dTable dTaken");
      const h = el("div", "dRow dCols");
      for (const c of ["Golpe", "De quem", "Dano", "Vezes"]) h.append(el("span", "", c));
      t.append(h);
      for (const g of taken) {
        const r = el("div", "dRow");
        r.append(el("span", "dSk", (window.LudraRecap ? window.LudraRecap.skillName(g.skill) : (g.skill || "").trim()) || "golpe desconhecido"), el("span", "dFrom", ((f) => (N ? N.text(f, "app", openDemo || null) : f))(window.LudraRecap ? window.LudraRecap.who(g.from) : (g.from || "").trim()) || "—"), el("span", "", num(g.total)), el("span", "", g.hits > 0 ? String(g.hits) : "—"));
        t.append(r);
      }
      panel.append(t);
    }

    // Cura
    if (d.heal_done > 0 || d.heal_received > 0) {
      panel.append(el("h3", "dH", "Cura"));
      const c = el("div", "dStats two");
      c.append(stat("Cura feita", num(d.heal_done), "green"), stat("Cura recebida", num(d.heal_received), "green"));
      panel.append(c);
    }
  }

  // The program's detail, else (Testar) the made-up one, else what the row shows.
  async function load() {
    if (openId == null) return;
    let d = null;
    if (T && !openDemo) {
      try {
        d = await T.core.invoke("meter_detail", { id: openId });
      } catch {
        d = null;
      }
    }
    if (!d && (openDemo || !T)) d = demo(seed);
    if (!d) d = { ...(seed || { id: openId }), skills: [], taken_by: [] };
    if (openId != null && panel) render(d);
  }

  function open(id, row) {
    openId = Number(id);
    openDemo = window.meterDetailDemo || false; // the made-up view, numbered on its own
    seed = row || null;
    if (!back) {
      back = el("div", "dBack");
      panel = el("div", "dPanel");
      panel.setAttribute("role", "dialog");
      back.append(panel);
      back.addEventListener("mousedown", (e) => e.target === back && close());
      document.body.append(back);
    }
    back.hidden = false;
    render({ ...(seed || { id: openId }), skills: [], taken_by: [] });
    load();
    clearInterval(timer);
    timer = setInterval(load, 1000);
  }

  function close() {
    openId = null;
    clearInterval(timer);
    if (back) back.hidden = true;
  }

  document.addEventListener("keydown", (e) => e.key === "Escape" && openId != null && close());
  window.LudraNames?.onChange(() => openId != null && load());
  window.meterDetail = { open, close, demo, get openId() { return openId; } };
})();
