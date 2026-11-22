// Layouts ("presets"): several saved ways of laying the boxes over the game,
// with their sizes and switches, changed with one click. The one in use
// follows every change made in the editor and the controls below it.
(function () {
  const T = window.__TAURI__;
  const sel = document.querySelector(".presetSel");
  if (!sel) return;
  const nameIn = document.querySelector(".presetName");
  const KEYS = [".widget", ".size", ".bgOpacity", ".bossOn", ".bossTheme", ".bossScale", ".bossAlpha", ".meterOn", ".meterScale", ".meterAlpha", ".meterOpacity", ".partyOn", ".partyScale", ".partyAlpha"];
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
  let presets = get("presets", null);
  let active = get("preset", null);
  let applying = false;
  function settings() {
    const o = {};
    for (const k of KEYS) {
      const e = document.querySelector(k);
      if (e) o[k] = e.type === "checkbox" ? e.checked : e.value;
    }
    return o;
  }
  async function positions() {
    if (!T) return {};
    try {
      const l = await T.core.invoke("overlay_layout");
      const o = {};
      for (const b of l.boxes) o[b.label] = { x: b.x - b.dx, y: b.y - b.dy };
      return o;
    } catch {
      return {};
    }
  }
  async function snapshot() {
    if (applying || !presets) return;
    const p = presets.find((x) => x.id === active);
    if (!p) return;
    p.settings = settings();
    p.pos = await positions();
    set("presets", presets);
  }
  function fill() {
    sel.replaceChildren();
    for (const p of presets) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      sel.append(o);
    }
    sel.value = active;
    document.querySelector(".presetDel").disabled = presets.length < 2;
  }
  async function apply(p) {
    applying = true;
    for (const [k, v] of Object.entries(p.settings || {})) {
      const e = document.querySelector(k);
      if (!e) continue;
      if (e.type === "checkbox") {
        if (e.checked !== v) {
          e.checked = v;
          e.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (e.value !== String(v)) {
        e.value = String(v);
        e.dispatchEvent(new Event(e.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
      }
    }
    // The windows take their new size first, then go to their places.
    setTimeout(async () => {
      for (const [label, q] of Object.entries(p.pos || {})) T && (await T.core.invoke("overlay_move", { label, x: q.x, y: q.y }).catch(() => {}));
      applying = false;
    }, 400);
  }
  async function init() {
    if (!presets || !presets.length) {
      presets = [{ id: "p1", name: "Ludra", settings: settings(), pos: await positions() }];
      active = "p1";
      set("presets", presets);
      set("preset", active);
    }
    if (!presets.some((p) => p.id === active)) active = presets[0].id;
    fill();
  }
  sel.addEventListener("change", async () => {
    await snapshot();
    active = sel.value;
    set("preset", active);
    const p = presets.find((x) => x.id === active);
    if (p) apply(p);
    fill();
  });
  // Naming: the box in place of the list, Enter to keep, Esc to drop.
  let naming = null;
  function askName(kind, start) {
    naming = kind;
    nameIn.value = start || "";
    nameIn.hidden = false;
    sel.hidden = true;
    nameIn.focus();
    nameIn.select();
  }
  async function doneName(keep) {
    const v = nameIn.value.trim();
    nameIn.hidden = true;
    sel.hidden = false;
    if (keep && v) {
      if (naming === "new") {
        await snapshot();
        const p = { id: `p${Date.now()}`, name: v, settings: settings(), pos: await positions() };
        presets.push(p);
        active = p.id;
        set("preset", active);
      } else {
        const p = presets.find((x) => x.id === active);
        if (p) p.name = v;
      }
      set("presets", presets);
    }
    naming = null;
    fill();
  }
  nameIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doneName(true);
    if (e.key === "Escape") doneName(false);
  });
  nameIn.addEventListener("blur", () => naming && doneName(true));
  document.querySelector(".presetNew").addEventListener("click", () => askName("new", `Layout ${presets.length + 1}`));
  document.querySelector(".presetRen").addEventListener("click", () => askName("rename", presets.find((x) => x.id === active)?.name));
  document.querySelector(".presetDel").addEventListener("click", () => {
    if (presets.length < 2) return;
    presets = presets.filter((x) => x.id !== active);
    active = presets[0].id;
    set("presets", presets);
    set("preset", active);
    apply(presets[0]);
    fill();
  });
  // Every change to the boxes goes into the layout in use.
  for (const k of KEYS) document.querySelector(k)?.addEventListener(k === ".bossTheme" || document.querySelector(k)?.type === "checkbox" ? "change" : "input", () => setTimeout(snapshot, 50));
  setInterval(snapshot, 3000);
  setTimeout(init, 800);
})();
