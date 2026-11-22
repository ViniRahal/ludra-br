// The party frames from the settings window: their switch, size and opacity,
// their window over the game shown while the game is found, and the "group
// cleanse" call (for Cleric and Chanter) from the meter's view.
(function () {
  const T = window.__TAURI__;
  const P = window.LudraParty;
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
  const sw = $(".partyOn");
  const cleanSw = $(".cleanseCall");
  const scaleIn = $(".partyScale");
  const alphaIn = $(".partyAlpha");
  let on = get("partyOn", true);
  let cleanse = get("cleanseCall", true);
  let scale = get("partyScale", 100);
  let alpha = get("partyAlpha", 100);
  if (sw) sw.checked = on;
  if (cleanSw) cleanSw.checked = cleanse;
  if (scaleIn) scaleIn.value = String(scale);
  if (alphaIn) alphaIn.value = String(alpha);
  let game = false, testing = false;
  // The box's background ("Fundo"), and "O que mostrar": the debuffs, the
  // aggro mark, and how many with the same debuff make the cleanse call.
  const opIn = $(".partyOpacity");
  let opacity = get("partyOpacity", 80);
  if (opIn) opIn.value = String(opacity);
  opIn && opIn.addEventListener("input", () => {
    opacity = Number(opIn.value);
    set("partyOpacity", opacity);
    look();
  });
  const show = { debuffs: get("partyDebuffs", true), aggro: get("partyAggro", true) };
  for (const [k, key] of [["debuffs", "partyDebuffs"], ["aggro", "partyAggro"]]) {
    const e = $(`.${key}`);
    if (!e) continue;
    e.checked = !!show[k];
    e.addEventListener("change", () => {
      show[k] = e.checked;
      set(key, show[k]);
      look();
    });
  }
  const minSel = $(".cleanseMin");
  let cleanseMin = get("cleanseMin", "3");
  if (minSel) minSel.value = String(cleanseMin);
  minSel && minSel.addEventListener("change", () => {
    cleanseMin = minSel.value;
    set("cleanseMin", cleanseMin);
  });

  const look = () => T && T.event.emitTo("party", "party-look", { scale: scale / 100, alpha: alpha / 100, opacity: opacity / 100, show: { ...show } });
  // Room for 8 members with debuffs: 260 wide, about 40 a row.
  const size = () => ({ width: Math.ceil(270 * scale / 100), height: Math.ceil(360 * scale / 100) });
  function place() {
    if (!T) return;
    if (on && (game || testing)) {
      T.core.invoke("overlay_show", { label: "party", ...size() });
      setTimeout(look, 300);
    } else T.core.invoke("overlay_hide", { label: "party" });
  }
  window.partyFramesOn = () => on;

  sw && sw.addEventListener("change", () => {
    on = sw.checked;
    set("partyOn", on);
    place();
  });
  cleanSw && cleanSw.addEventListener("change", () => {
    cleanse = cleanSw.checked;
    set("cleanseCall", cleanse);
  });
  scaleIn && scaleIn.addEventListener("input", () => {
    scale = Number(scaleIn.value);
    set("partyScale", scale);
    place();
    look();
  });
  alphaIn && alphaIn.addEventListener("input", () => {
    alpha = Number(alphaIn.value);
    set("partyAlpha", alpha);
    look();
  });
  window.a2 && a2.on("game", (d) => {
    game = !!(d && d.running);
    place();
  });
  T && T.event.listen("party-hello", () => look());

  // The group cleanse: only for those who can do it.
  const last = new Map();
  const healer = (v) => {
    const c = v && v.me && v.me.class;
    return c === "cleric" || c === "chanter";
  };
  function checkCleanse(v, now = Date.now()) {
    if (!cleanse || !healer(v) || !P.inFight(v)) return;
    for (const c of P.cleanseCalls(v.frames, now, last, 8000, Number(cleanseMin) || 3)) window.ludraCall?.(c);
  }
  T && T.event.listen("meter", (e) => checkCleanse(e.payload || {}));

  // "Testar": a made-up party on screen for a few seconds, and the call.
  const test = $(".test");
  test && test.addEventListener("click", () => {
    const fake = { demo: true, time_ms: 169000, target_boss: true, me: { name: "Dark", class: "cleric" }, boss: { aggro: "Tankão" }, frames: P.DEMO_FRAMES };
    if (on && T) {
      testing = true;
      place();
      setTimeout(() => T.event.emitTo("party", "party-demo", fake), 400);
      setTimeout(() => {
        testing = false;
        place();
      }, 9000);
    }
    if (cleanse) setTimeout(() => checkCleanse(fake), 5000);
  });
})();
