// The boss panel from the settings window: its switch, and its window over
// the game shown while the game is found, fed the engine's state of the boss.
(function () {
  const T = window.__TAURI__;
  const sw = document.querySelector(".bossOn");
  const get = (k, d) => {
    try {
      const v = localStorage.getItem(`ludra:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  };
  const set = (k, v) => {
    try {
      localStorage.setItem(`ludra:${k}`, JSON.stringify(v));
    } catch {}
  };
  let on = get("bossOn", true);
  const themeSel = document.querySelector(".bossTheme");
  let theme = get("bossTheme", "moldura");
  themeSel.value = theme;
  const scaleIn = document.querySelector(".bossScale");
  const alphaIn = document.querySelector(".bossAlpha");
  let scale = get("bossScale", 100);
  let alpha = get("bossAlpha", 100);
  scaleIn.value = String(scale);
  alphaIn.value = String(alpha);
  const look = () => T && T.event.emitTo("boss", "boss-look", { theme, scale: scale / 100, alpha: alpha / 100 });
  scaleIn.addEventListener("input", () => {
    scale = Number(scaleIn.value);
    set("bossScale", scale);
    place();
    look();
  });
  alphaIn.addEventListener("input", () => {
    alpha = Number(alphaIn.value);
    set("bossAlpha", alpha);
    look();
  });
  themeSel.addEventListener("change", () => {
    theme = themeSel.value;
    set("bossTheme", theme);
    look();
  });
  let game = false;
  let testing = false;
  let live = null;
  sw.checked = on;
  window.bossPanelOn = () => on;
  function place() {
    if (!T) return;
    if (on && (game || testing)) {
      T.core.invoke("overlay_show", { label: "boss", width: Math.ceil(440 * scale / 100), height: Math.ceil(130 * scale / 100) });
      setTimeout(look, 300);
    }
    else T.core.invoke("overlay_hide", { label: "boss" });
  }
  const push = () => T && T.event.emitTo("boss", "boss-live", live);
  // From plugin.js: the boss now (null: none). A made-up one for "Testar"
  // comes with its own aggro and stagger.
  window.bossLive = (s, fake) => {
    live = s;
    if (fake !== undefined) {
      testing = !!fake;
      place();
      if (fake && T) T.event.emitTo("boss", "meter", { target: s && s.name, rows: [], boss: { id: 1, ...fake } });
    }
    push();
  };
  // The clock and the "mata em" move every second even with no new HP.
  setInterval(push, 1000);
  sw.addEventListener("change", () => {
    on = sw.checked;
    set("bossOn", on);
    place();
    window.refreshWidget?.();
  });
  a2.on("game", (d) => {
    game = !!(d && d.running);
    place();
  });
  T && T.event.listen("boss-hello", () => {
    push();
    look();
  });
})();
