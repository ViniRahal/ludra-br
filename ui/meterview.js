// The damage table, as in the meters players know: one row per player, with
// the class's emblem, the name, damage per second, the last 10 seconds' and
// the total, the bar the share of the group's damage.
(function () {
  const COLORS = { templar: "#3b6fe0", gladiator: "#2fb5e8", cleric: "#e2b23a", chanter: "#f08a24", spiritmaster: "#d84fd8", sorcerer: "#8a5cf0", ranger: "#2ec4a0", assassin: "#4ccf5a", fighter: "#e05050" };
  const NAMES = { templar: "Templar", gladiator: "Gladiador", cleric: "Clérigo", chanter: "Chanter", spiritmaster: "Espiritualista", sorcerer: "Feiticeiro", ranger: "Arqueiro", assassin: "Assassino", fighter: "Lutador" };
  const short = (n) => {
    n = Number(n) || 0;
    const f = (v, u) => `${v.toFixed(v >= 1000 ? 0 : 1).replace(".", ",")}${u}`;
    if (n >= 1e9) return f(n / 1e9, "B");
    if (n >= 1e6) return f(n / 1e6, "M");
    if (n >= 1e3) return f(n / 1e3, "K");
    return String(Math.round(n));
  };
  const clock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const icon = (cls) => {
    const i = el("span", "mIcon");
    if (cls && cls !== "fighter") {
      const img = el("img");
      img.src = `classes/${cls}.png`;
      img.alt = NAMES[cls] || "";
      i.append(img);
    } else i.textContent = (NAMES[cls] || "?").slice(0, 1);
    return i;
  };
  // "Esconder nomes" (names.js): the name to draw; the data keeps the real one.
  const N = () => window.LudraNames;
  // v: the view the name comes from ("Testar" numbers its made-up players on its own).
  const shown = (name, info, scope, v) => (N() ? N().name(name, info, scope, v) : name);
  // The bottom line: your ping, the key that opens the settings and, once
  // "Esconder nomes" was used, the quick button that flips it (for a live).
  // Locked, a click goes to the game, so the button hides there (meter.css)
  // and only a plain tag says the names are hidden.
  function foot(box, v, opts) {
    const f = el("div", "mFoot");
    // An empty label: the key was turned off (Atalhos de teclado).
    if (window.hotkeyLabel !== "") f.append(el("span", "mKey", `${window.hotkeyLabel || "Alt+E"} opções`));
    const np = N() && N().prefs;
    if (np && np.on && N().active(opts.scope)) f.append(el("span", "mNamesTag", "🙈 nomes ocultos"));
    if (np && N().showButton()) {
      const hidden = N().active(opts.scope);
      const b = el("button", `mNames${np.on ? " on" : ""}`, np.on ? "🙈 Mostrar nomes" : "Esconder nomes");
      b.type = "button";
      b.title = np.on ? "Os nomes estão escondidos. Clique para mostrar." : "Esconde os nomes dos jogadores (para gravar ou fazer live).";
      if (np.on && !hidden) b.title += " Nesta janela eles continuam aparecendo (mude em Vídeo e live > Modo live).";
      // Not a press on the meter: no drag, no double-click to the settings.
      b.addEventListener("mousedown", (e) => e.stopPropagation());
      b.addEventListener("mouseup", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        N().toggle();
      });
      f.append(b);
    }
    // "Mostrar o ping" off: the line keeps the key and the names button only
    // (and goes when nothing is left in it).
    if (opts.ping !== false) {
      const p = v && v.ping;
      const ping = el("span", `mPing${p == null ? "" : p < 80 ? " good" : p < 150 ? " mid" : " bad"}`, p == null ? "— ms" : `${p} ms`);
      f.append(ping);
    }
    if ((f.children || []).length) box.append(f);
  }
  // opts: { empty, scope, max (rows), cp, now, ping } — the last three are
  // the meter's "O que mostrar" switches, on unless set to false.
  window.renderMeter = function (box, v, opts = {}) {
    box.replaceChildren();
    box.classList?.toggle("noNow", opts.now === false);
    const rows = (v && v.rows) || [];
    const party = (v && v.party) || [];
    const me = v && v.me;
    const head = el("div", "mHead");
    const top = el("div", "mTop");
    if (!rows.length) {
      // Out of a fight: your group, as the game's party list has it.
      top.append(el("span", "mBrand", "LUDRA BR"));
      if (party.length > 1) top.append(el("span", "mTab", `Grupo · ${party.length}`));
      head.append(top);
      const list = party.length ? party : me && me.name ? [{ ...me, me: true }] : [];
      box.append(head);
      if (!list.length) box.append(el("div", "mEmpty", opts.empty || "Personagem não identificado: dê um TP"));
      else {
        const cols = el("div", "mCols");
        cols.append(el("span", "", ""), el("span", "", ""), el("span", "", "GS"), el("span", "", "CP"));
        box.append(cols);
        for (const m of list) {
          const row = el("div", `mRow mParty${m.me ? " me" : ""}`);
          row.style.setProperty("--c", COLORS[m.class] || "#8892a6");
          row.style.setProperty("--w", "100%");
          const name = el("span", "mName");
          name.append(el("span", "n", shown(m.name, { me: m.me, cls: m.class }, opts.scope, v)));
          if (m.level) name.append(el("span", "cp", `Nv. ${m.level}`));
          row.append(icon(m.class), name, el("span", "mGs", m.gs ? m.gs.toLocaleString("pt-BR") : "—"), el("span", "mCp", m.cp ? short(m.cp) : "—"));
          box.append(row);
        }
      }
      foot(box, v, opts);
      return;
    }
    top.append(el("span", "mBrand", "LUDRA BR"), el("span", "mTime", v && v.time_ms ? clock(v.time_ms) : "0:00"));
    head.append(top);
    const total = el("div", "mTotal");
    total.append(el("b", "", v ? short(v.dps) : "0"), el("span", "", " DPS"));
    head.append(total);
    if (v && v.target) head.append(el("div", "mTarget", v.target));
    box.append(head);
    const top1 = Math.max(...rows.map((r) => r.total)) || 1;
    for (const r of rows.slice(0, opts.max || 12)) {
      const row = el("div", `mRow${r.me ? " me" : ""}`);
      row.dataset.id = String(r.id);
      const color = COLORS[r.class] || "#8892a6";
      row.style.setProperty("--c", color);
      // The bar glides from where it was to where it is now (4 updates a second).
      const w = `${Math.max(2, (r.total / top1) * 100)}%`;
      const widths = (box.__w ||= new Map());
      row.style.setProperty("--w", widths.get(r.id) || w);
      widths.set(r.id, w);
      requestAnimationFrame(() => row.style.setProperty("--w", w));
      const name = el("span", "mName");
      const label = shown(r.name, { me: r.me, cls: r.class, id: r.id }, opts.scope, v);
      name.append(el("span", "n", label));
      if (r.cp > 0 && opts.cp !== false) name.append(el("span", "cp", short(r.cp)));
      if (r.deaths > 0) name.append(el("span", "dead", `☠${r.deaths}`));
      const now = el("span", `mNow${r.now > r.dps * 1.05 ? " up" : ""}`, short(r.now));
      row.append(icon(r.class), name, el("span", "mDps", short(r.dps)), now, el("span", "mSum", short(r.total)));
      row.title = `${label}: ${Math.round(r.share)}% do dano do grupo. Clique para ver o detalhe.`;
      box.append(row);
    }
    // Opened with the game already running, the names come with the next
    // area load: until then a player shows as "#id".
    if (rows.some((r) => r.name.startsWith("#"))) box.append(el("div", "mHint", "Dê um TP para o app ver os nomes"));
    foot(box, v, opts);
  };
  // How see-through the meter over the game is. In a fight: the player's
  // "Opacidade". Out of one ("Fora da luta"): "fade" at half of it (to see
  // the game behind), "show" as in a fight, "hide" gone, except while the
  // player is placing the boxes (or it could not be found to drag). 0: hidden.
  const idleAlpha = (mode, fight, arranging, alpha = 1) => {
    if (fight || mode === "show") return alpha;
    if (mode === "hide" && !arranging) return 0;
    return alpha * 0.5;
  };
  window.meterKit = { COLORS, NAMES, short, clock, icon, el, shown, idleAlpha };
})();
