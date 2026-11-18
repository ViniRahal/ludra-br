// The boss panel, as players know it from Questlog: the HP % big on the left,
// the boss's name, the red HP bar with the time it dies in at this pace, the
// blue stagger gauge under it, and who has the aggro.
(function () {
  const COLORS = { templar: "#5b8cff", gladiator: "#3cc8f0", cleric: "#f0c24a", chanter: "#ff9a3c", spiritmaster: "#e070e0", sorcerer: "#a07cff", ranger: "#3fd6b0", assassin: "#5fdc6a", fighter: "#ff6a6a" };
  const clock = (s) => {
    s = Math.max(0, Math.round(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const pctText = (p) => (p == null ? "—" : p >= 10 ? `${Math.floor(p)}%` : `${p.toFixed(1).replace(".", ",")}%`);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // live: the engine's state ({ name, pct, cur, dps, pullAt, enrage, next }),
  // view: the meter's ({ target, boss: { stagger, aggro, aggro_class, aggro_me } }).
  window.renderBoss = function (box, live, view, opts = {}) {
    const now = Date.now();
    const b = view && view.boss;
    // A Ludra boss: the engine's own reading (with its calls). Any other boss
    // of the game: the meter's target, its name and HP from the game.
    const ours = live && live.key;
    const other = !ours && view && view.target && view.target_boss && view.target_pct != null;
    if (other) {
      live = {
        name: view.target,
        pct: view.target_pct,
        cur: view.target_hp,
        dps: view.dps,
        pullAt: view.time_ms > 0 ? now - view.time_ms : 0,
        marks: [],
      };
    }
    const name = live ? live.name : null;
    box.replaceChildren();
    box.classList.toggle("empty", !name);
    if (!name) {
      if (opts.preview) {
        box.append(el("div", "bEmpty", "Painel do boss — arraste para onde quiser"));
      } else box.classList.add("gone");
      return;
    }
    box.classList.remove("gone");
    const pct = live && live.pct != null ? live.pct : null;
    const left = el("div", "bLeft");
    left.append(el("div", "bPct", pctText(pct)));
    const right = el("div", "bRight");
    const top = el("div", "bTop");
    top.append(el("span", "bName", name));
    const el2 = live && live.pullAt ? (now - live.pullAt) / 1000 : 0;
    if (live && live.pullAt) top.append(el("span", "bClock", `⏱ ${clock(el2)}`));
    right.append(top);
    // One line per bar: the bar, and its number on the right.
    const line = (bar, num, cls, tip, label) => {
      const r = el("div", `bLine ${cls}`);
      const n = el("div", "bNum");
      if (label && num) n.append(el("small", "", `${label} `));
      n.append(document.createTextNode(num));
      r.append(bar, n);
      if (tip) r.title = tip;
      right.append(r);
    };
    // HP: red, going down; on the right, when it dies at this pace (moves with the damage).
    const red = el("div", "bHp");
    const fill = el("div", "bHpFill");
    fill.style.width = `${Math.max(0, Math.min(100, pct ?? 0))}%`;
    red.append(fill);
    // The thresholds still to come, as ticks on the bar.
    for (const t of (live && live.marks) || []) {
      const m = el("div", "bMark");
      m.style.left = `${t}%`;
      red.append(m);
    }
    const kill = live && live.dps > 0 && live.cur > 0 ? clock(live.cur / live.dps) : "";
    line(red, kill, "lHp", "Vida do boss. À direita: mata em (pelo dano de agora)", "mata em");
    // Stagger: blue, filling up to the break.
    if (b && b.stagger != null) {
      const blue = el("div", "bStag");
      const f2 = el("div", "bStagFill");
      f2.style.width = `${Math.max(0, Math.min(100, b.stagger))}%`;
      blue.append(f2);
      line(blue, "", "lStag", `Stagger: ${Math.round(b.stagger)}%`);
    }
    // Enrage: orange, going down one second at a time from the pull.
    if (live && live.enrage > 0) {
      const leftS = live.pullAt ? live.enrage - el2 : live.enrage;
      const bar = el("div", "bRage");
      const f3 = el("div", "bRageFill");
      f3.style.width = `${Math.max(0, Math.min(100, (leftS / live.enrage) * 100))}%`;
      bar.append(f3);
      line(bar, leftS > 0 ? clock(leftS) : "ENRAGE", `lRage${leftS <= 60 ? " hot" : ""}`, "Tempo até o enrage", leftS > 0 ? "enrage" : "");
    }
    const bottom = el("div", "bBottom");
    if (b && b.aggro) {
      const a = el("span", `bAggro${b.aggro_me ? " me" : ""}`);
      a.style.setProperty("--c", COLORS[b.aggro_class] || "#7fe0ff");
      if (b.aggro_class && b.aggro_class !== "fighter") {
        const img = el("img");
        img.src = `classes/${b.aggro_class}.png`;
        img.alt = "";
        a.append(img);
      } else a.append(el("span", "bTarget", "◎"));
      a.append(el("span", "", b.aggro_me ? `${b.aggro} (você)` : b.aggro));
      a.title = "Com o aggro: em quem o boss está batendo";
      bottom.append(a);
    } else bottom.append(el("span", "bAggro none", "aggro: —"));
    // The next mechanic: by time when one is due within a minute, else by HP.
    const up = live && live.upcoming;
    const upIn = up ? Math.max(0, (up.at - now) / 1000) : Infinity;
    if (upIn <= 60) bottom.append(el("span", `bNext${upIn <= 5 ? " soon" : ""}`, `próxima: ${up.title.replace(/!/g, "")} em ${clock(upIn)}`));
    else if (live && live.next) bottom.append(el("span", "bNext", `próxima: ${live.next.title} em ${String(live.next.pct).replace(".", ",")}%`));
    right.append(bottom);
    box.append(left, right);
  };
})();
