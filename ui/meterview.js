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
  // The bottom line: your ping and the key that opens the settings.
  function foot(box, v) {
    const f = el("div", "mFoot");
    f.append(el("span", "mKey", "Alt+E opções"));
    const p = v && v.ping;
    const ping = el("span", `mPing${p == null ? "" : p < 80 ? " good" : p < 150 ? " mid" : " bad"}`, p == null ? "— ms" : `${p} ms`);
    f.append(ping);
    box.append(f);
  }
  window.renderMeter = function (box, v, opts = {}) {
    box.replaceChildren();
    const rows = (v && v.rows) || [];
    const party = (v && v.party) || [];
    const me = v && v.me;
    const head = el("div", "mHead");
    const top = el("div", "mTop");
    if (!rows.length) {
      // Out of a fight: your group, as the game's party list has it.
      top.append(el("span", "mBrand", "LUDRA BR"), el("span", "mTab", party.length ? `Grupo · ${party.length}` : "Solo"));
      head.append(top);
      const list = party.length ? party : me && me.name ? [{ ...me, me: true }] : [];
      const cps = list.map((m) => m.cp).filter((c) => c > 0);
      const total = el("div", "mTotal");
      total.append(el("b", "", cps.length ? short(cps.reduce((a, b) => a + b, 0) / cps.length) : "—"), el("span", "", " CP médio"));
      head.append(total);
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
          name.append(el("span", "n", m.name));
          if (m.level) name.append(el("span", "cp", `Nv. ${m.level}`));
          row.append(icon(m.class), name, el("span", "mGs", m.gs ? m.gs.toLocaleString("pt-BR") : "—"), el("span", "mCp", m.cp ? short(m.cp) : "—"));
          box.append(row);
        }
      }
      foot(box, v);
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
      const color = COLORS[r.class] || "#8892a6";
      row.style.setProperty("--c", color);
      row.style.setProperty("--w", `${Math.max(2, (r.total / top1) * 100)}%`);
      const name = el("span", "mName");
      name.append(el("span", "n", r.name));
      if (r.cp > 0) name.append(el("span", "cp", short(r.cp)));
      if (r.deaths > 0) name.append(el("span", "dead", `☠${r.deaths}`));
      const now = el("span", `mNow${r.now > r.dps * 1.05 ? " up" : ""}`, short(r.now));
      row.append(icon(r.class), name, el("span", "mDps", short(r.dps)), now, el("span", "mSum", short(r.total)));
      row.title = `${r.name}: ${Math.round(r.share)}% do dano do grupo`;
      box.append(row);
    }
    // Opened with the game already running, the names come with the next
    // area load: until then a player shows as "#id".
    if (rows.some((r) => r.name.startsWith("#"))) box.append(el("div", "mHint", "Dê um TP para o app ver os nomes"));
    foot(box, v);
  };
})();
