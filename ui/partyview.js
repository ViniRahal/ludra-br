// The party frames, as players know them from raid tools: one row per member,
// the class's emblem, the name, the HP bar in the class's color with the %,
// a mark on whom the boss is attacking, and the debuffs on them with the
// seconds left (red edge: it can be cleansed). Also the rule for the "group
// cleanse" call: the same debuff on 3 or more at once.
(function (root) {
  const COLORS = { templar: "#5b8cff", gladiator: "#3cc8f0", cleric: "#f0c24a", chanter: "#ff9a3c", spiritmaster: "#e070e0", sorcerer: "#a07cff", ranger: "#3fd6b0", assassin: "#5fdc6a", fighter: "#ff6a6a" };
  const NAMES = { templar: "Templar", gladiator: "Gladiador", cleric: "Clérigo", chanter: "Chanter", spiritmaster: "Espiritualista", sorcerer: "Feiticeiro", ranger: "Arqueiro", assassin: "Assassino", fighter: "Lutador" };
  const LOW = 35;
  const MAX_CHIPS = 4;

  // The HP % of a frame: the game's %, else from hp/max_hp, else null.
  function pctOf(f) {
    if (!f) return null;
    if (f.dead) return 0;
    if (typeof f.hp_pct === "number" && isFinite(f.hp_pct)) return Math.max(0, Math.min(100, f.hp_pct));
    if (f.max_hp > 0 && typeof f.hp === "number") return Math.max(0, Math.min(100, (f.hp / f.max_hp) * 100));
    return null;
  }
  const pctText = (p) => (p == null ? "" : p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1).replace(".", ",")}%`);
  const secsText = (s) => (s == null || !isFinite(s) ? "" : s >= 60 ? `${Math.floor(s / 60)}m` : `${Math.max(0, Math.ceil(s))}s`);

  // The debuffs that count for a cleanse: cleansable, or harmful when the
  // game did not say whether it can be cleansed.
  const counts = (d) => d && (d.cleansable === true || (d.cleansable == null && d.harmful));

  // The same debuff on `min` or more living members now: [{ key, name, n }],
  // most members first. A key is the debuff's id (else its name).
  function groupDebuffs(frames, min = 3) {
    const by = new Map();
    for (const f of frames || []) {
      if (!f || f.dead) continue;
      const seen = new Set();
      for (const d of f.debuffs || []) {
        if (!counts(d)) continue;
        const key = d.id != null && d.id !== 0 ? `id:${d.id}` : `n:${d.name || ""}`;
        if (key === "n:" || seen.has(key)) continue;
        seen.add(key);
        const e = by.get(key) || { key, name: d.name || "debuff", n: 0 };
        e.n++;
        by.set(key, e);
      }
    }
    return [...by.values()].filter((e) => e.n >= min).sort((a, b) => b.n - a.n);
  }

  // Which group cleanse calls to make now, at most one per `gapMs` per debuff;
  // `last` (a Map key -> ms) is kept by the caller between calls.
  function cleanseCalls(frames, now, last, gapMs = 8000) {
    const out = [];
    for (const g of groupDebuffs(frames)) {
      if (now - (last.get(g.key) || -Infinity) < gapMs) continue;
      last.set(g.key, now);
      out.push({
        kind: "cast",
        text: `LIMPEZA EM GRUPO: ${g.name} em ${g.n}`,
        sub: "Use a limpeza em área agora.",
        say: `Limpeza em grupo. ${g.name} em ${g.n}`,
      });
    }
    return out;
  }

  // In a fight: the meter has a fight going (time or a boss target).
  const inFight = (v) => !!(v && ((v.time_ms || 0) > 0 || v.target_boss || (v.rows && v.rows.length)));

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(cls) {
    const i = el("span", "pIcon");
    if (cls && cls !== "fighter") {
      const img = el("img");
      img.src = `classes/${cls}.png`;
      img.alt = NAMES[cls] || "";
      i.append(img);
    }
    return i;
  }

  // view: the meter's (with `frames`, and `boss.aggro`); opts.preview: draw
  // the empty box to be placed.
  function renderParty(box, view, opts = {}) {
    const frames = ((view && view.frames) || []).filter((f) => f && f.name);
    box.replaceChildren();
    const show = frames.length && (opts.always || inFight(view));
    box.classList.toggle("empty", !show);
    if (!show) {
      if (opts.preview) {
        box.classList.remove("gone");
        box.append(el("div", "pEmpty", "Quadro da party — arraste para onde quiser"));
      } else box.classList.add("gone");
      return;
    }
    box.classList.remove("gone");
    const aggroName = view && view.boss && view.boss.aggro;
    for (const f of frames) {
      const p = pctOf(f);
      const aggro = !!f.aggro || (!!aggroName && aggroName === f.name);
      const row = el("div", `pRow${f.me ? " me" : ""}${f.dead ? " dead" : ""}${p != null && !f.dead && p < LOW ? " low" : ""}`);
      row.style.setProperty("--c", COLORS[f.class] || "#9fb4c8");
      const head = el("div", "pHead");
      head.append(icon(f.class));
      const name = el("span", "pName", f.name);
      head.append(name);
      if (aggro) head.append(el("span", "pAggro", "🎯"));
      if (f.dead) head.append(el("span", "pDead", "☠"));
      row.append(head);
      if (p != null) {
        const bar = el("div", "pBar");
        const fill = el("div", "pFill");
        fill.style.width = `${p}%`;
        bar.append(fill);
        bar.append(el("span", "pPct", f.dead ? "morto" : pctText(p)));
        row.append(bar);
      }
      const debs = (f.debuffs || []).filter((d) => d && (d.harmful || d.cleansable));
      if (debs.length && !f.dead) {
        const chips = el("div", "pChips");
        for (const d of debs.slice(0, MAX_CHIPS)) {
          const c = el("span", `pChip${d.cleansable ? " clean" : ""}`);
          c.title = `${d.name || "debuff"}${d.cleansable ? " (pode limpar)" : ""}`;
          c.append(el("span", "pChipName", d.name || "debuff"));
          const s = secsText(d.secs_left);
          if (d.stacks > 1) c.append(el("b", "", `×${d.stacks}`));
          if (s) c.append(el("span", "pChipSecs", s));
          chips.append(c);
        }
        if (debs.length > MAX_CHIPS) chips.append(el("span", "pChip more", `+${debs.length - MAX_CHIPS}`));
        row.append(chips);
      }
      box.append(row);
    }
  }

  // Made-up party for "Testar".
  const DEMO_FRAMES = [
    { id: 1, name: "Dark", class: "assassin", me: true, level: 45, hp_pct: 82, hp: 41000, max_hp: 50000, dead: false, aggro: false, debuffs: [{ id: 501, name: "Choque", secs_left: 6, stacks: 1, harmful: true, cleansable: true }] },
    { id: 2, name: "IndioBala", class: "chanter", me: false, level: 45, hp_pct: 64, hp: 32000, max_hp: 50000, dead: false, aggro: false, debuffs: [{ id: 501, name: "Choque", secs_left: 5, stacks: 1, harmful: true, cleansable: true }] },
    { id: 3, name: "Tankão", class: "templar", me: false, level: 45, hp_pct: 28, hp: 19600, max_hp: 70000, dead: false, aggro: true, debuffs: [{ id: 501, name: "Choque", secs_left: 6, stacks: 1, harmful: true, cleansable: true }, { id: 77, name: "Armadura quebrada", secs_left: 12, stacks: 3, harmful: true, cleansable: false }] },
    { id: 4, name: "Millennium", class: "chanter", me: false, level: 45, hp_pct: 0, hp: 0, max_hp: 50000, dead: true, aggro: false, debuffs: [] },
    { id: 5, name: "RickSanchez", class: "cleric", me: false, level: 45, hp_pct: null, hp: 0, max_hp: 0, dead: false, aggro: false, debuffs: [] },
  ];

  root.LudraParty = { pctOf, groupDebuffs, cleanseCalls, inFight, DEMO_FRAMES, COLORS };
  root.renderParty = renderParty;
})(typeof window !== "undefined" ? window : globalThis);
