// "Esconder nomes" from the settings window: its switches, the example line,
// and the hook a hotkey can call. The setting itself lives in names.js
// (shared by every window); this page only edits it.
(function () {
  const N = window.LudraNames;
  if (!N) return;
  const T = window.__TAURI__;
  const $ = (s) => document.querySelector(s);
  const on = $(".namesOn"), keepMe = $(".namesKeepMe"), style = $(".namesStyle"), where = $(".namesWhere"), button = $(".namesButton"), announce = $(".namesAnnounce");
  const preview = $(".namesPreview");
  // Made-up group for the example line (you first).
  const DEMO = [
    { name: "Dark", class: "assassin", me: true },
    { name: "IndioBala", class: "chanter" },
    { name: "Tankão", class: "templar" },
    { name: "RickSanchez", class: "cleric" },
  ];
  function show(p) {
    if (on) on.checked = p.on;
    if (keepMe) keepMe.checked = p.keepMe;
    if (style) style.value = p.style;
    if (where) where.value = p.where;
    if (button) button.checked = p.button;
    if (announce) announce.checked = p.announce;
    // The options only matter with the names hidden: dimmed, but still editable.
    for (const el of [keepMe, style, where]) el && el.closest("label")?.classList.toggle("dim", !p.on);
    if (preview) {
      const nm = N.forList(DEMO, { ...p, on: true });
      preview.textContent = `Fica assim: ${DEMO.map((x) => nm(x.name, { me: x.me, cls: x.class })).join(", ")}${p.on ? "" : " (desligado agora)"}`;
    }
  }
  const bind = (el, key, read) => el && el.addEventListener("change", () => N.set({ [key]: read(el) }));
  bind(on, "on", (e) => e.checked);
  bind(keepMe, "keepMe", (e) => e.checked);
  bind(style, "style", (e) => e.value);
  bind(where, "where", (e) => e.value);
  bind(button, "button", (e) => e.checked);
  bind(announce, "announce", (e) => e.checked);
  // Whatever flipped it (this switch, the meter's button, a hotkey), the
  // player is told the same way on the big text, since they may be in the
  // game and can't see this window. Only when "on" really changed.
  let wasOn = N.prefs.on;
  function tell(p) {
    if (p.on === wasOn) return;
    wasOn = p.on;
    if (p.announce) window.ludraCall?.({ kind: "pre", text: p.on ? "NOMES ESCONDIDOS" : "NOMES VISÍVEIS", sub: "", say: "", quiet: true });
  }
  N.onChange(show);
  N.onChange(tell);
  show(N.prefs);
  // The other windows may have opened before this one read the setting.
  setTimeout(() => T && T.event && T.event.emit("names-mask", N.prefs).catch?.(() => {}), 800);

  // The hook for a hotkey (or anything else): flips the names; tell() above
  // says so on the big text.
  function toggle() {
    return N.toggle().on;
  }
  window.ludraNames = { toggle, set: (p) => N.set(p), get prefs() { return N.prefs; } };
  // A global hotkey in the program can just emit "names-toggle".
  T && T.event && T.event.listen("names-toggle", () => toggle());
})();
