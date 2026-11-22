// "Esconder nomes": for recording or streaming, the players' names on screen
// become "Jogador 1, 2, 3" (or "Gladiador 1, Clérigo 2"). Only what is drawn
// changes: the meter's data, the saved fights and the logs keep the real
// names, and every view asks here for the text to show.
//
// The numbers stay the same for the whole fight: the party first, in the
// game's party order (so the group gets the same numbers every pull), then
// the others in the order they show up. Every window over the game gets the
// same "meter" events, so each one numbers the same way on its own.
//
// The settings window owns the switch; any window may flip it (the button
// under the meter), and the new setting goes to every window with the
// "names-mask" event (and the shared localStorage as a fallback).
(function (root) {
  const KEY = "ludra:hideNames";
  // on: hide; keepMe: your own name stays; style: "player" (Jogador 1) or
  // "class" (Gladiador 1); where: "game" (only the boxes over the game) or
  // "all" (this window too); button: the quick button under the meter, shown
  // only once the switch was turned on at least once (used), so players who
  // never stream do not get it; announce: say on the big text when it flips.
  const DEFAULTS = { on: false, keepMe: true, style: "player", where: "game", button: true, announce: true, used: false };
  const CLASS = { templar: "Templar", gladiator: "Gladiador", cleric: "Clérigo", chanter: "Chanter", spiritmaster: "Espiritualista", sorcerer: "Feiticeiro", ranger: "Arqueiro", assassin: "Assassino", fighter: "Lutador" };

  const clean = (p) => {
    const o = { ...DEFAULTS, ...(p && typeof p === "object" ? p : {}) };
    return {
      on: !!o.on,
      keepMe: !!o.keepMe,
      style: o.style === "class" ? "class" : "player",
      where: o.where === "all" ? "all" : "game",
      button: !!o.button,
      announce: !!o.announce,
      used: !!o.used || !!o.on,
    };
  };
  const load = () => {
    try {
      return clean(JSON.parse(root.localStorage.getItem(KEY)));
    } catch {
      return clean(null);
    }
  };
  const store = (p) => {
    try {
      root.localStorage.setItem(KEY, JSON.stringify(p));
    } catch {}
  };

  const keyOf = (name) => String(name == null ? "" : name).trim();
  // You, when "Mostrar o meu nome" is off.
  const ME = "Você";

  // The numbering for one fight (or one saved fight): name -> { n, cls, cn }.
  // Only seed() (and note()) hand out the numbers, and every window gets the
  // same "meter" events, so "Jogador 3" is the same player in every box. A
  // name the meter never showed (the cast's target with no damage yet, a
  // made-up player) gets a window-only "Outro N" from label() instead, so it
  // can not push everyone after it off by one in this window alone.
  // You are kept out of the numbers: with "Mostrar o meu nome" on the others
  // read 1, 2, 3 (no missing "Jogador 1"), and off you show as "Você".
  function createMasker() {
    let byName = new Map();
    let byId = new Map();
    let n = 0;
    let perClass = {};
    let meName = "";
    let others = new Map();
    let otherN = 0;
    function classNo(e, cls) {
      if (e.me || !cls || !CLASS[cls] || e.cls) return;
      e.cls = cls;
      e.cn = perClass[cls] = (perClass[cls] || 0) + 1;
    }
    // Read only: the entry for this name, or for this id while it was "#id".
    function find(k, id) {
      let e = byName.get(k);
      if (!e && id && byId.has(id)) {
        e = byId.get(id);
        if (!e.key.startsWith("#")) e = null;
      }
      return e || null;
    }
    // Gives `name` its number (once). A player first seen as "#id" (the
    // name not read yet) keeps that number when the name comes. You (me)
    // get no number.
    function note(name, cls, id, me) {
      const k = keyOf(name);
      if (!k) return null;
      me = !!me || (!!meName && k === meName);
      let e = find(k, id);
      if (e && e.key !== k) {
        byName.delete(e.key);
        e.key = k;
        byName.set(k, e);
      }
      if (!e) {
        e = { key: k, n: me ? 0 : ++n, cls: "", cn: 0, me };
        byName.set(k, e);
      }
      if (id) byId.set(id, e);
      classNo(e, cls);
      return e;
    }
    // A saved fight that kept the live numbers (the Resumo): those again.
    function noteAs(name, cls, no, cno) {
      const k = keyOf(name);
      if (!k || byName.has(k)) return;
      const e = { key: k, n: no, cls: cno && CLASS[cls] ? cls : "", cn: cno && CLASS[cls] ? cno : 0, me: false };
      byName.set(k, e);
      n = Math.max(n, no);
      if (e.cls) perClass[cls] = Math.max(perClass[cls] || 0, e.cn);
    }
    function reset() {
      byName = new Map();
      byId = new Map();
      n = 0;
      perClass = {};
      others = new Map();
      otherN = 0;
    }
    // The meter's view: the party in order, then the meter's rows by id
    // (a new player gets the next number, the others keep theirs).
    function seed(v) {
      if (!v || typeof v !== "object") return;
      const frames = Array.isArray(v.frames) ? v.frames : [];
      const party = Array.isArray(v.party) ? v.party : [];
      const rows = (Array.isArray(v.rows) ? v.rows : []).filter((r) => r && r.name);
      // Who you are first, so you never take a number by being seen early.
      const meOf = (v.me && v.me.name) || [...frames, ...party, ...rows].find((x) => x && x.me && x.name)?.name;
      if (meOf) meName = keyOf(meOf);
      for (const f of frames) if (f && f.name) note(f.name, f.class, f.id, f.me);
      for (const m of party) if (m && m.name) note(m.name, m.class, 0, m.me);
      if (!frames.length && !party.length && v.me && v.me.name) note(v.me.name, v.me.class, v.me_id || 0, true);
      for (const r of rows.slice().sort((a, b) => (a.id || 0) - (b.id || 0))) note(r.name, r.class, r.id, r.me);
    }
    const known = (name) => byName.has(keyOf(name));
    // The text to show for a player. info: { me, cls, id }.
    function label(name, info, p) {
      const k = keyOf(name);
      if (!k) return name;
      info = info || {};
      const e = find(k, info.id);
      if (!!info.me || (!!meName && k === meName) || (e && e.me)) return p.keepMe ? name : ME;
      if (!e) {
        let o = others.get(k);
        if (!o) others.set(k, (o = ++otherN));
        return `Outro ${o}`;
      }
      if (p.style === "class" && e.cls && e.cn) return `${CLASS[e.cls]} ${e.cn}`;
      return `Jogador ${e.n}`;
    }
    // The numbers a player has now (to keep them with a saved fight).
    function numbers(name, id) {
      const e = find(keyOf(name), id);
      return e && !e.me ? { no: e.n, cno: e.cn } : null;
    }
    return {
      seed, note, noteAs, reset, known, label, numbers,
      setMe(name) { meName = keyOf(name); },
      get meName() { return meName; },
      get size() { return byName.size; },
    };
  }

  // A new fight. The meter's view carries `pull` (meter.rs: raised when the
  // fight history starts a boss fight), and only a new pull starts the
  // numbers again (from the party, so the group's numbers do not change
  // between pulls). `time_ms` alone is no boundary: it is the current
  // target's clock and drops when you switch to an add mid-fight.
  // A view without `pull` (an older program): a new fight only when the
  // rows come back after being empty, or the clock went back after it had
  // stood still for 10 s (the last fight was over).
  function fightTracker() {
    let pull = null, had = false, last = 0, movedAt = 0;
    return (v, now = Date.now()) => {
      if (v && typeof v.pull === "number") {
        const fresh = v.pull !== pull;
        pull = v.pull;
        return fresh;
      }
      const rows = !!(v && Array.isArray(v.rows) && v.rows.length);
      const t = (v && Number(v.time_ms)) || 0;
      let fresh = rows && !had;
      if (rows && t !== last) {
        if (had && t + 2000 < last && now - movedAt >= 10000) fresh = true;
        movedAt = now;
        last = t;
      }
      had = rows;
      return fresh;
    };
  }

  // A saved fight (Resumo, Histórico): the numbers it kept from the live
  // meter (the Resumo saves them), else numbered by its own list (highest
  // damage first), so the same fight always reads the same.
  function forList(players, p) {
    const m = createMasker();
    const list = (players || []).filter((x) => x && x.name);
    for (const x of list) if (x.me) m.setMe(x.name);
    for (const x of list) if (!x.me && x.no > 0) m.noteAs(x.name, x.class, x.no, x.cno || 0);
    for (const x of list) m.note(x.name, x.class, 0, x.me);
    const fn = (name, info) => (p.on ? m.label(name, info, p) : name);
    // A name that may be a monster's: hidden only when it is one of the list.
    fn.text = (name) => (p.on && name && (m.known(name) || (m.meName && keyOf(name) === m.meName)) ? m.label(name, null, p) : name);
    return fn;
  }

  let prefs = load();
  const live = createMasker();
  const isNewFight = fightTracker();
  // A made-up view ("Testar", the examples) is numbered on its own, so its
  // players never take numbers from the real fight's.
  const demos = new WeakMap();
  const maskerFor = (v) => {
    if (!v || typeof v !== "object" || !v.demo) return live;
    let m = demos.get(v);
    if (!m) {
      m = createMasker();
      m.seed(v);
      demos.set(v, m);
    }
    return m;
  };
  const subs = [];
  const changed = () => {
    for (const f of subs) {
      try {
        f(prefs);
      } catch (e) {
        console.error(e);
      }
    }
  };
  // "game": a box over the game; "app": the settings window.
  const active = (scope) => prefs.on && (scope !== "app" || prefs.where === "all");

  const api = {
    DEFAULTS, CLASS, clean, createMasker, fightTracker, forList,
    get prefs() { return prefs; },
    active,
    ME,
    // Each window gets every meter view here (the listener below); a
    // made-up one is left out.
    seed(v) {
      if (v && v.demo) return;
      if (isNewFight(v)) live.reset();
      live.seed(v);
    },
    // A player's name as it should be drawn (always a player: rows, party,
    // aggro, the cast's target). v: the view it comes from, when that may
    // be a made-up one.
    name(name, info, scope, v) {
      return active(scope) ? maskerFor(v).label(name, info, prefs) : name;
    },
    // A name that may be a monster's (who hit, the killing blow): hidden
    // only when it is one of the players seen.
    text(name, scope, v) {
      if (!active(scope) || !name) return name;
      const m = maskerFor(v);
      const k = keyOf(name);
      return m.known(k) || (m.meName && k === m.meName) ? m.label(k, null, prefs) : name;
    },
    // The player's numbers in this fight ({ no, cno }, null: none or you),
    // kept with a saved fight so its Resumo reads as the live meter did.
    numbers(name, id) {
      return live.numbers(name, id);
    },
    // The quick button under the meter: turned on, and the switch used once.
    showButton() {
      return prefs.button && prefs.used;
    },
    // A saved fight's own numbering, for the Resumo and the Histórico.
    list(players, scope) {
      return forList(players, active(scope) ? prefs : { ...prefs, on: false });
    },
    onChange(f) {
      subs.push(f);
    },
    set(next, quiet) {
      prefs = clean({ ...prefs, ...(next || {}) });
      store(prefs);
      const T = root.__TAURI__;
      if (!quiet && T && T.event && T.event.emit) T.event.emit("names-mask", prefs).catch?.(() => {});
      changed();
      return prefs;
    },
    // The quick switch (the meter's button, a hotkey).
    toggle() {
      return api.set({ on: !prefs.on });
    },
  };

  const T = root.__TAURI__;
  if (T && T.event) {
    // Every window numbers from every view, even one that does not draw the
    // meter (the cast bar), so "Jogador 2" is the same player in every box.
    T.event.listen("meter", (e) => api.seed(e.payload));
    T.event.listen("names-mask", (e) => {
      const p = clean(e.payload);
      if (JSON.stringify(p) === JSON.stringify(prefs)) return;
      prefs = p;
      changed();
    });
  }
  // Another window wrote it (the same app shares its storage).
  if (typeof root.addEventListener === "function") {
    root.addEventListener("storage", (e) => {
      if (e.key !== KEY) return;
      const p = load();
      if (JSON.stringify(p) === JSON.stringify(prefs)) return;
      prefs = p;
      changed();
    });
  }
  root.LudraNames = api;
})(typeof window !== "undefined" ? window : globalThis);
