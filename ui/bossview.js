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
  // opts.show: the panel's "O que mostrar" ({ stagger, rage, aggro, next,
  // kill, others }), each on unless false.
  window.renderBoss = function (box, live, view, opts = {}) {
    const now = Date.now();
    const sh = opts.show || {};
    const on = (k) => sh[k] !== false;
    const b = view && view.boss;
    // A Ludra boss: the engine's own reading (with its calls). Any other boss
    // of the game: the meter's target, its name and HP from the game.
    const ours = live && live.key;
    const other = !ours && on("others") && view && view.target && view.target_boss && view.target_pct != null;
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
    if (live && live.diff) top.append(el("span", `bDiff ${live.diff}`, live.diff === "hard" ? "HARD" : "NORMAL"));
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
    const kill = on("kill") && live && live.dps > 0 && live.cur > 0 ? clock(live.cur / live.dps) : "";
    line(red, kill, "lHp", "Vida do boss. À direita: mata em (pelo dano de agora)", "mata em");
    // Stagger: blue, filling up to the break.
    if (on("stagger") && b && b.stagger != null) {
      const blue = el("div", "bStag");
      const f2 = el("div", "bStagFill");
      f2.style.width = `${Math.max(0, Math.min(100, b.stagger))}%`;
      blue.append(f2);
      line(blue, "", "lStag", `Stagger: ${Math.round(b.stagger)}%`);
    }
    // Enrage: orange, going down one second at a time from the pull.
    if (on("rage") && live && live.enrage > 0) {
      const leftS = live.pullAt ? live.enrage - el2 : live.enrage;
      const bar = el("div", "bRage");
      const f3 = el("div", "bRageFill");
      f3.style.width = `${Math.max(0, Math.min(100, (leftS / live.enrage) * 100))}%`;
      bar.append(f3);
      line(bar, leftS > 0 ? clock(leftS) : "ENRAGE", `lRage${leftS <= 60 ? " hot" : ""}`, "Tempo até o enrage", leftS > 0 ? "enrage" : "");
    }
    const bottom = el("div", "bBottom");
    if (!on("aggro")) {
      // nothing: the bottom line keeps only the next mechanic
    } else if (b && b.aggro) {
      const a = el("span", `bAggro${b.aggro_me ? " me" : ""}`);
      a.style.setProperty("--c", COLORS[b.aggro_class] || "#7fe0ff");
      if (b.aggro_class && b.aggro_class !== "fighter") {
        const img = el("img");
        img.src = `classes/${b.aggro_class}.png`;
        img.alt = "";
        a.append(img);
      } else a.append(el("span", "bTarget", "◎"));
      // "Esconder nomes" (names.js): only the text drawn changes.
      const N = window.LudraNames;
      const who = N ? N.name(b.aggro, { me: b.aggro_me, cls: b.aggro_class }, opts.scope, view) : b.aggro;
      a.append(el("span", "", b.aggro_me && !(N && who === N.ME) ? `${who} (você)` : who));
      a.title = "Com o aggro: em quem o boss está batendo";
      bottom.append(a);
    } else bottom.append(el("span", "bAggro none", "aggro: —"));
    // The next mechanic: by time when one is due within a minute, else by HP.
    const up = live && live.upcoming;
    const upIn = up ? Math.max(0, (up.at - now) / 1000) : Infinity;
    if (!on("next")) {
      // the player turned it off
    } else if (upIn <= 60) bottom.append(el("span", `bNext${upIn <= 5 ? " soon" : ""}`, `próxima: ${up.title.replace(/!/g, "")} em ${clock(upIn)}`));
    else if (live && live.next) bottom.append(el("span", "bNext", `próxima: ${live.next.title} em ${String(live.next.pct).replace(".", ",")}%`));
    if ((bottom.children || []).length) right.append(bottom);
    box.append(left, right);
  };
})();

// The boss cast bar (its own box over the game, cast.html): each skill the
// boss is casting, its name, whom it is aimed at (red when it is you) and a
// bar that runs down with the time left. The idea is Aion-DPS-Meter's "Boss
// cast bar" (MIT, Copyright (c) 2026 SkeeveTV); the drawing is our own.
(function () {
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const secs = (ms) => {
    const s = Math.max(0, ms) / 1000;
    return s >= 10 ? `${Math.ceil(s)}s` : `${s.toFixed(1).replace(".", ",")}s`;
  };
  // What a bar shows, for one moment: the part of the bar left and the time text.
  window.castLeft = function (b, now) {
    const total = Math.max(1, b.end - b.start);
    const left = Math.max(0, b.end - now);
    return { frac: Math.min(1, left / total), text: secs(left) };
  };
  // bars: [{ id, title, sub, known, start, end, target, targetMe }], already
  // picked (castctl.js). opts: { target, sub, preview }. Built again only when
  // the bars change; the countdowns move in place.
  window.renderCasts = function (box, bars, opts = {}) {
    const now = Date.now();
    const live = (bars || []).filter((b) => b.end > now);
    // "Esconder nomes" (names.js): whom it is aimed at, as it should be drawn.
    // A monster or NPC (a summon) keeps its name; a player the meter has not
    // shown yet becomes "Outro N" in this box, so the numbers stay the same as
    // in the other boxes. The made-up bars ("Ver exemplo") are numbered on
    // their own.
    const N = window.LudraNames;
    const demoNames = N && N.list(live.filter((b) => b.demo && b.target && !b.targetMe).map((b) => ({ name: b.target })), opts.scope);
    const aim = (b) => {
      if (!N || !b.target) return b.target;
      if (b.targetMe) return N.name(b.target, { me: true }, opts.scope);
      if (b.demo) return demoNames(b.target);
      return b.targetNpc ? N.text(b.target, opts.scope) : N.name(b.target, {}, opts.scope);
    };
    const sig = JSON.stringify([live.map((b) => [b.id, aim(b)]), !!opts.target, !!opts.sub, !!opts.preview]);
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.replaceChildren();
      box.classList.toggle("empty", !live.length);
      box.classList.toggle("gone", !live.length && !opts.preview);
      if (!live.length && opts.preview) box.append(el("div", "cEmpty", "Barra de cast do boss — arraste para onde quiser"));
      for (const b of live) {
        const me = !!(opts.target && b.targetMe);
        const row = el("div", `cRow${me ? " me" : ""}${b.known ? "" : " unknown"}`);
        row.dataset.id = b.id;
        const top = el("div", "cTop");
        top.append(el("span", "cName", b.title));
        if (opts.target && (b.target || b.targetMe)) top.append(el("span", `cAim${me ? " me" : ""}`, me ? "EM VOCÊ" : `em ${aim(b)}`));
        top.append(el("span", "cTime", ""));
        const bar = el("div", "cBar");
        bar.append(el("div", "cFill"));
        row.append(top, bar);
        if (opts.sub && b.sub) row.append(el("div", "cSub", b.sub));
        box.append(row);
      }
    }
    for (const row of box.querySelectorAll(".cRow")) {
      const b = live.find((x) => x.id === row.dataset.id);
      if (!b) continue;
      const l = window.castLeft(b, now);
      row.querySelector(".cFill").style.width = `${(l.frac * 100).toFixed(1)}%`;
      row.querySelector(".cTime").textContent = l.text;
      row.classList.toggle("soon", b.end - now <= 1500);
    }
    return live.length;
  };
})();
