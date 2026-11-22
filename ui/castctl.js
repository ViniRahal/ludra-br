// The boss cast bar from the settings window: its switches and sizes, its
// window over the game shown while the game is found, fed what the engine
// (logic.js) says the boss is casting, picked by the player's options.
(function () {
  const T = window.__TAURI__;
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
  const $ = (s) => document.querySelector(s);
  // Each option: its control, its saved key and its default.
  const opts = {
    on: { el: $(".castOn"), key: "castOn", def: true },
    unknown: { el: $(".castUnknown"), key: "castUnknown", def: false },
    target: { el: $(".castTarget"), key: "castTarget", def: true },
    sub: { el: $(".castSub"), key: "castSub", def: false },
    max: { el: $(".castMax"), key: "castMax", def: "2" },
    scale: { el: $(".castScale"), key: "castScale", def: 100 },
    alpha: { el: $(".castAlpha"), key: "castAlpha", def: 100 },
  };
  const v = {};
  for (const [name, o] of Object.entries(opts)) {
    v[name] = get(o.key, o.def);
    if (!o.el) continue;
    if (o.el.type === "checkbox") o.el.checked = !!v[name];
    else o.el.value = String(v[name]);
  }
  const themeSel = $(".bossTheme"); // the same look as the boss panel
  // `live` is always the engine's last word; `testList` only lives during a
  // test, so a test never throws away a real cast running under it.
  let game = false, testing = false, live = [], testList = [], testTimer = 0, forced = false;
  const max = () => Math.max(1, Math.min(3, Number(v.max) || 2));

  const look = () =>
    T && T.event.emitTo("cast", "cast-look", { theme: (themeSel && themeSel.value) || "moldura", scale: v.scale / 100, alpha: v.alpha / 100, target: !!v.target, sub: !!v.sub });
  const push = () => T && T.event.emitTo("cast", "cast-bars", window.LudraEngine.pickBars(testing ? testList : live, v));
  // Room for the rows asked for, a dica line each when it is on.
  const size = () => ({ width: Math.ceil(380 * v.scale / 100), height: Math.ceil(((v.sub ? 62 : 44) * max() + 22) * v.scale / 100) });
  function place() {
    if (!T) return;
    // "Ver exemplo" shows it even while switched off, so the player can try
    // the look before turning it on; "Testar" follows the switch.
    if ((v.on && game) || (testing && (v.on || forced))) {
      T.core.invoke("overlay_show", { label: "cast", ...size() });
      setTimeout(() => {
        look();
        push();
      }, 300);
    } else T.core.invoke("overlay_hide", { label: "cast" });
  }
  window.castBarOn = () => !!v.on;
  // From plugin.js (the engine's `bars` hook): what the boss is casting now.
  window.castBarsLive = (bars) => {
    live = Array.isArray(bars) ? bars : [];
    if (v.on && !testing) push(); // the test bars stay their few seconds
  };

  for (const [name, o] of Object.entries(opts)) {
    if (!o.el) continue;
    const ev = o.el.type === "range" ? "input" : "change";
    o.el.addEventListener(ev, () => {
      v[name] = o.el.type === "checkbox" ? o.el.checked : o.el.type === "range" ? Number(o.el.value) : o.el.value;
      set(o.key, v[name]);
      if (name === "on" || name === "scale" || name === "max" || name === "sub") place();
      look();
      push();
    });
  }
  themeSel && themeSel.addEventListener("change", look);
  window.a2 && a2.on("game", (d) => {
    game = !!(d && d.running);
    place();
  });
  T && T.event.listen("cast-hello", () => {
    look();
    push();
  });

  // "Testar" (Início) and "Ver exemplo" (this card): three made-up casts for
  // a few seconds, one of them at you, one the app doesn't know. Pressing
  // again starts the test over instead of letting the old timer cut it short.
  function runTest(force) {
    if (!T || (!v.on && !force)) return;
    const at = Date.now();
    testing = true;
    forced = !!force;
    testList = [
      { id: "t1", title: "BINGO", sub: "Achem o quadrado azul. No atordoamento, BATAM TUDO.", known: true, start: at, end: at + 8000, target: "Maximus", targetMe: false, demo: true },
      { id: "t2", title: "CONE", sub: "Cone laranja na frente do boss. Saiam da frente.", known: true, start: at, end: at + 4000, target: "Você", targetMe: true, demo: true },
      { id: "t3", title: "Golpe Sombrio", sub: "", known: false, start: at, end: at + 3000, target: "", targetMe: false, demo: true },
    ];
    clearTimeout(testTimer);
    place();
    push();
    testTimer = setTimeout(() => {
      testing = false;
      forced = false;
      testList = [];
      push(); // back to what the boss is really casting
      place();
    }, 9000);
  }
  const test = $(".test");
  test && test.addEventListener("click", () => runTest(false));
  const castTest = $(".castTest");
  castTest && castTest.addEventListener("click", () => runTest(true));
})();
