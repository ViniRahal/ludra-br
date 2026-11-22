// The overlay editor: the screen the game is on, drawn small, with a box for
// each thing over the game. Dragging a box moves the real one.
(function () {
  const T = window.__TAURI__;
  const screen = document.querySelector(".screen");
  if (!screen) return;
  const NAMES = { overlay: "Avisos de mecânica", boss: "Vida do boss", meter: "Medidor de dano", party: "Quadro da party", cast: "Barra de cast do boss" };
  // The name on the box itself: short, so that two boxes side by side do not
  // cover each other's names.
  const TAGS = { overlay: "Avisos", boss: "Vida do boss", meter: "Medidor de dano", party: "Party", cast: "Cast do boss" };
  // What each box is, in a few words: on the list under the screen and when
  // the mouse is over the box.
  const DESC = { overlay: "O aviso grande do que fazer (ONDA, BINGO, ZIKEL...)", boss: "Vida do boss, quem está com o aggro, stagger e enrage", cast: "A habilidade que o boss está soltando e quanto falta", meter: "O dano de cada um da party", party: "A vida de cada um da party e os debuffs" };
  const ORDER = ["overlay", "boss", "cast", "meter", "party"];
  const num = (label) => (ORDER.indexOf(label) + 1 || ORDER.length + 1);
  const legend = document.querySelector(".oLegend");
  let legendRows = {};
  const light = (label, on) => {
    els[label]?.classList.toggle("lit", on);
    legendRows[label]?.classList.toggle("lit", on);
  };
  const COLORS = { overlay: "#ffd84d", boss: "#ff6b62", meter: "#4ea3f5", party: "#5fdc6a", cast: "#c08bff" };
  let layout = null, drag = null, els = {};
  const pane = () => document.querySelector('[data-pane="overlays"]');
  function draw() {
    if (!layout) return;
    const m = layout.monitor;
    screen.style.aspectRatio = `${m.w} / ${m.h}`;
    const k = screen.clientWidth / m.w;
    document.querySelector(".screenSize").textContent = `Tela ${m.w}×${m.h}`;
    for (const b of layout.boxes) {
      let e = els[b.label];
      if (!e) {
        e = els[b.label] = document.createElement("div");
        e.className = "obox";
        e.style.setProperty("--c", COLORS[b.label] || "#aaa");
        e.innerHTML = `<span class="oTag"></span><i class="grip"></i><i class="grip tl"></i><i class="grip tr"></i><i class="grip bl"></i>`;
        e.querySelector(".oTag").textContent = TAGS[b.label] || NAMES[b.label] || b.label;
        e.title = `${NAMES[b.label] || b.label}: ${DESC[b.label] || ""}`;
        e.addEventListener("pointerenter", () => light(b.label, true));
        e.addEventListener("pointerleave", () => light(b.label, false));
        e.addEventListener("pointerdown", (ev) => (ev.target.classList.contains("grip") ? startSize(ev, b.label) : start(ev, b.label)));
        screen.append(e);
      }
      if (drag && drag.label === b.label) continue;
      e.style.left = `${(b.x - m.x) * k}px`;
      e.style.top = `${(b.y - m.y) * k}px`;
      // The name always goes inside the box: a box smaller than its name is
      // drawn just big enough to hold it.
      const tag = e.querySelector(".oTag");
      const w = Math.max(b.w * k, tag.scrollWidth + 14), h = Math.max(b.h * k, 24);
      e.style.width = `${w}px`;
      e.style.height = `${h}px`;
      e.classList.toggle("off", !b.visible);
    }
    drawLegend();
  }
  // The list under the screen: number, name, what it is, and if it is on the
  // screen now. The mouse over a line lights its box (and the other way).
  function drawLegend() {
    if (!legend || !layout) return;
    const boxes = layout.boxes.slice().sort((a, b) => num(a.label) - num(b.label));
    const key = boxes.map((b) => `${b.label}:${b.visible}`).join(",");
    if (legend.dataset.key === key) return;
    legend.dataset.key = key;
    legend.replaceChildren();
    legendRows = {};
    for (const b of boxes) {
      const r = document.createElement("div");
      r.className = "oLeg";
      r.style.setProperty("--c", COLORS[b.label] || "#aaa");
      r.innerHTML = `<span class="oDot"></span><span class="oLegTxt"><b></b><small></small></span><span class="oState"></span>`;
      r.querySelector("b").textContent = NAMES[b.label] || b.label;
      r.querySelector("small").textContent = DESC[b.label] || "";
      const st = r.querySelector(".oState");
      st.textContent = b.visible ? "Na tela" : "Escondido agora";
      st.classList.toggle("on", !!b.visible);
      r.addEventListener("pointerenter", () => light(b.label, true));
      r.addEventListener("pointerleave", () => light(b.label, false));
      legendRows[b.label] = r;
      legend.append(r);
    }
  }
  async function load() {
    if (!T || drag || pane().hidden) return;
    try {
      layout = await T.core.invoke("overlay_layout");
      draw();
    } catch {}
  }
  let last = 0;
  // A corner pulled: the box grows or shrinks, as a picture does. Its size
  // is the same setting as the "Tamanho" slider below, which moves with it.
  const SLIDER = { overlay: ".size", boss: ".bossScale", meter: ".meterScale", party: ".partyScale", cast: ".castScale" };
  let size = null;
  function startSize(ev, label) {
    ev.preventDefault();
    ev.stopPropagation();
    const input = document.querySelector(SLIDER[label]);
    if (!input) return;
    const e = els[label];
    e.setPointerCapture(ev.pointerId);
    size = { label, e, input, sx: ev.clientX, sy: ev.clientY, w: e.offsetWidth, h: e.offsetHeight, v: Number(input.value), corner: ev.target.className };
    drag = { label, e, b: {}, fake: true };
    e.classList.add("dragging");
  }
  window.addEventListener("pointermove", (ev) => {
    if (!size) return;
    const left = /tl|bl/.test(size.corner), up = /tl|tr/.test(size.corner);
    const dw = (ev.clientX - size.sx) * (left ? -1 : 1);
    const dh = (ev.clientY - size.sy) * (up ? -1 : 1);
    const r = Math.max((size.w + dw) / size.w, (size.h + dh) / size.h);
    const i = size.input;
    const min = Number(i.min), max = Number(i.max), step = Number(i.step) || 1;
    const v = Math.max(min, Math.min(max, Math.round((size.v * r) / step) * step));
    size.e.style.width = `${size.w * (v / size.v)}px`;
    size.e.style.height = `${size.h * (v / size.v)}px`;
    if (String(v) !== i.value) {
      i.value = String(v);
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  window.addEventListener("pointerup", () => {
    if (!size) return;
    size.e.classList.remove("dragging");
    size = null;
    drag = null;
    setTimeout(load, 400);
  });
  function start(ev, label) {
    ev.preventDefault();
    const b = layout.boxes.find((x) => x.label === label);
    const e = els[label];
    e.setPointerCapture(ev.pointerId);
    drag = { label, b, e, sx: ev.clientX, sy: ev.clientY, left: parseFloat(e.style.left), top: parseFloat(e.style.top) };
    e.classList.add("dragging");
  }
  window.addEventListener("pointermove", (ev) => {
    if (!drag || drag.fake) return;
    const m = layout.monitor;
    const k = screen.clientWidth / m.w;
    let left = drag.left + ev.clientX - drag.sx;
    let top = drag.top + ev.clientY - drag.sy;
    const W = screen.clientWidth, H = screen.clientHeight;
    left = Math.max(0, Math.min(W - drag.e.offsetWidth, left));
    top = Math.max(0, Math.min(H - drag.e.offsetHeight, top));
    if (document.querySelector(".snap").checked) {
      const g = W / 48;
      left = Math.round(left / g) * g;
      top = Math.round(top / g) * g;
    }
    drag.e.style.left = `${left}px`;
    drag.e.style.top = `${top}px`;
    const now = Date.now();
    if (now - last > 30) {
      last = now;
      move(left, top, k, m);
    }
  });
  function move(left, top, k, m) {
    const x = Math.round(m.x + left / k - drag.b.dx);
    const y = Math.round(m.y + top / k - drag.b.dy);
    T && T.core.invoke("overlay_move", { label: drag.label, x, y }).catch(() => {});
  }
  window.addEventListener("pointerup", () => {
    if (!drag || drag.fake) return;
    const m = layout.monitor;
    move(parseFloat(drag.e.style.left), parseFloat(drag.e.style.top), screen.clientWidth / m.w, m);
    drag.e.classList.remove("dragging");
    drag = null;
    setTimeout(load, 200);
  });
  // "Voltar as caixas ao lugar inicial": the program puts every box back
  // where it starts on a first install (a box lost off-screen comes back).
  const note = document.querySelector(".resetNote");
  const NOTE = note ? note.textContent : "";
  const say = (t) => {
    if (!note) return;
    note.textContent = t;
    clearTimeout(say.t);
    say.t = setTimeout(() => (note.textContent = NOTE), 6000);
  };
  document.querySelector(".placeReset")?.addEventListener("click", async () => {
    if (!T) return;
    try {
      await T.core.invoke("overlay_reset_positions");
      say("Pronto: as caixas voltaram ao lugar inicial.");
    } catch {
      say("Não deu para mover as caixas agora.");
    }
    setTimeout(load, 300);
  });
  // "Tamanhos e opacidade padrão": each slider of the boxes back to the value
  // it comes with (the same defaults as in plugin.js and the *ctl.js files);
  // the "input" event lets each box take it, as a drag of the slider would.
  const LOOK_DEFAULTS = { ".size": 60, ".bgOpacity": 80, ".bossScale": 100, ".bossAlpha": 100, ".meterScale": 100, ".meterAlpha": 100, ".meterOpacity": 85, ".partyScale": 100, ".partyAlpha": 100, ".partyOpacity": 80, ".castScale": 100, ".castAlpha": 100 };
  document.querySelector(".lookResetAll")?.addEventListener("click", () => {
    for (const [sel, v] of Object.entries(LOOK_DEFAULTS)) {
      const i = document.querySelector(sel);
      if (!i || i.value === String(v)) continue;
      i.value = String(v);
      i.dispatchEvent(new Event("input", { bubbles: true }));
    }
    say("Pronto: tamanhos e opacidade como vieram.");
    setTimeout(load, 400);
  });
  window.addEventListener("resize", draw);
  setInterval(load, 1000);
  document.querySelector('.tab[data-tab="overlays"]')?.addEventListener("click", () => setTimeout(load, 50));
  load();
})();
