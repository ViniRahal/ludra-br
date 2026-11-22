// The damage meter from the settings window: its switch, its tab, and its
// window over the game shown while the game is found.
(function () {
  const T = window.__TAURI__;
  const sw = document.querySelector(".meterOn");
  const op = document.querySelector(".meterOpacity");
  const tab = document.querySelector(".mainMeter");
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
  let on = get("meterOn", true);
  let opacity = get("meterOpacity", 86);
  let game = false;
  let view = null;
  sw.checked = on;
  op.value = String(opacity);
  function place() {
    if (!T) return;
    if (on && game) T.core.invoke("overlay_show", { label: "meter", width: Math.ceil(400 * scale / 100), height: Math.ceil(470 * scale / 100) });
    else T.core.invoke("overlay_hide", { label: "meter" });
  }
  const scaleIn = document.querySelector(".meterScale");
  const alphaIn = document.querySelector(".meterAlpha");
  let scale = get("meterScale", 100);
  let alpha = get("meterAlpha", 100);
  scaleIn.value = String(scale);
  alphaIn.value = String(alpha);
  const look = () => T && T.event.emitTo("meter", "meter-look", { opacity: opacity / 100, scale: scale / 100, alpha: alpha / 100 });
  scaleIn.addEventListener("input", () => {
    scale = Number(scaleIn.value);
    set("meterScale", scale);
    place();
    look();
  });
  alphaIn.addEventListener("input", () => {
    alpha = Number(alphaIn.value);
    set("meterAlpha", alpha);
    look();
  });
  sw.addEventListener("change", () => {
    on = sw.checked;
    set("meterOn", on);
    place();
  });
  op.addEventListener("input", () => {
    opacity = Number(op.value);
    set("meterOpacity", opacity);
    look();
  });
  a2.on("game", (d) => {
    game = !!(d && d.running);
    place();
    setTimeout(look, 500);
  });
  T && T.event.listen("meter", (e) => {
    view = e.payload;
    renderMeter(tab, view, { empty: "Nenhuma luta ainda. Bata no boss e os números aparecem aqui." });
  });
  renderMeter(tab, null, { empty: "Nenhuma luta ainda. Bata no boss e os números aparecem aqui." });
  const DEMO_RECAP = {
    seq: "demo", id: 1, name: "Dark", class: "assassin", me: true, at_ms: 0, killer: "Ludra", skill: "Raio em linha", skill_id: 1803290,
    damage: 85000, window_ms: 2100, taken: 152000,
    hits: [
      { before_ms: 2100, from: "Ludra", skill: "Cone", damage: 41000 },
      { before_ms: 1200, from: "Ludra", skill: "Anel roxo", damage: 26000 },
      { before_ms: 0, from: "Ludra", skill: "Raio em linha", damage: 85000 },
    ],
  };
  // "Testar" shows a made-up meter too.
  document.querySelector(".test").addEventListener("click", () => {
    const fake = { target: "Ludra da Eternidade (teste)", target_id: 1, time_ms: 169000, dps: 165100, rows: [
      { id: 1, name: "Dark", class: "assassin", dps: 81100, now: 48500, total: 13.7e6, share: 49, deaths: 1, cp: 193600, me: true },
      { id: 2, name: "IndioBala", class: "chanter", dps: 40000, now: 77900, total: 6.8e6, share: 24, deaths: 0, cp: 196700, me: false },
      { id: 3, name: "JSHOW", class: "assassin", dps: 20600, now: 10800, total: 3.5e6, share: 12, deaths: 0, cp: 133800, me: false },
      { id: 4, name: "Millennium", class: "chanter", dps: 15500, now: 11600, total: 2.6e6, share: 9, deaths: 3, cp: 142300, me: false },
      { id: 5, name: "RickSanchez", class: "cleric", dps: 7900, now: 16400, total: 1.3e6, share: 5, deaths: 0, cp: 131800, me: false },
    ], recaps: [DEMO_RECAP] };
    renderMeter(tab, fake);
    // "O que te matou": the card you get when you die, a moment later.
    setTimeout(() => window.ludraNewRecap?.(DEMO_RECAP), 2500);
    if (on && T) {
      T.core.invoke("overlay_show", { label: "meter", width: 400, height: 470 });
      T.event.emitTo("meter", "meter", fake);
      look();
      setTimeout(() => {
        T.event.emitTo("meter", "meter", view || { rows: [] });
        renderMeter(tab, view, { empty: "Nenhuma luta ainda. Bata no boss e os números aparecem aqui." });
        place();
      }, 9000);
    }
  });
})();
