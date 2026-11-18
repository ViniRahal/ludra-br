// The few calls the Ludra BR pages make (written first for the A2 Tools meter,
// as a plugin), done here by Ludra BR's own program: the records come from
// its capture, the big text is its own window, the settings stay on this
// computer.
(function () {
  const T = window.__TAURI__;
  const invoke = (cmd, args) => (T ? T.core.invoke(cmd, args) : Promise.resolve(null));
  const handlers = {};
  const fire = (name, ...args) => {
    for (const h of handlers[name] || []) {
      try {
        h(...args);
      } catch (e) {
        console.error(e);
      }
    }
  };
  const on = (name, h) => {
    (handlers[name] ||= []).push(h);
  };
  const listen = (name, h) => T && T.event.listen(name, (e) => h(e.payload));
  const isOverlay = location.pathname.endsWith("overlay.html");

  const store = {
    async get(k) {
      try {
        const v = localStorage.getItem(`ludra:${k}`);
        return v == null ? null : JSON.parse(v);
      } catch {
        return null;
      }
    },
    async set(k, v) {
      try {
        localStorage.setItem(`ludra:${k}`, JSON.stringify(v));
      } catch {}
    },
  };

  const NAMES = { hp: "decoded:npc-hp", spawn: "decoded:spawn", cast: "decoded:boss-cast", use: "decoded:boss-skill", buff: "decoded:boss-buff" };

  if (!isOverlay) {
    listen("pkt", (batch) => {
      for (const r of batch || []) {
        const name = NAMES[r.type];
        if (name) fire(name, r, { at: r.at });
        window.a2.seen[r.type === "hp" || r.type === "spawn" ? "hp" : "skill"]++;
      }
    });
    let running = false;
    const status = (s) => {
      if (!s) return;
      fire("status", s);
      if (!!s.game !== running) {
        running = !!s.game;
        fire("game", { running });
      }
    };
    listen("status", status);
    // Once every page script has its handlers on.
    const first = () => invoke("status").then(status);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", first);
    else setTimeout(first, 0);
    listen("widget-message", (data) => fire("widget-message", { data }));
    // Locked as it was left.
    store.get("locked").then((on) => on && invoke("overlay_lock", { on: true }));
  } else {
    listen("widget", (d) => fire("widget", d));
  }
  listen("locked", (v) => fire("locked", v));

  window.a2 = {
    on,
    ready() {},
    storage: store,
    window: { show: () => invoke("show_main") },
    widgets: {
      open: (_name, size) => invoke("overlay_show", { width: size.width, height: size.height }),
      close: () => invoke("overlay_hide"),
      send: (_name, data) => (T ? T.event.emitTo("overlay", "widget", data) : Promise.resolve()),
      lock: (on) => {
        store.set("locked", !!on);
        return invoke("overlay_lock", { on: !!on });
      },
      locked: () => store.get("locked").then((v) => !!v),
    },
    widget: {
      // Unlocked, clicks on these boxes move the text; the rest go to the game.
      areas: (list) => invoke("overlay_areas", { areas: list || [] }),
      drag: () => invoke("overlay_drag"),
      post: (data) => (T ? T.event.emitTo("main", "widget-message", data) : Promise.resolve()),
    },
    openNpcap: () => invoke("open_npcap"),
    seen: { hp: 0, skill: 0 },
  };
})();
