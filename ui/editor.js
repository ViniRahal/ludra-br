// The overlay editor: the screen the game is on, drawn small, with a box for
// each thing over the game. Dragging a box moves the real one.
(function () {
  const T = window.__TAURI__;
  const screen = document.querySelector(".screen");
  if (!screen) return;
  const NAMES = { overlay: "Avisos de mecânica", boss: "Painel do boss", meter: "Medidor de dano", party: "Quadro da party" };
  const COLORS = { overlay: "#ffd84d", boss: "#ff6b62", meter: "#4ea3f5", party: "#5fdc6a" };
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
        e.innerHTML = `<b></b><small></small><i class="grip"></i><i class="grip tl"></i><i class="grip tr"></i><i class="grip bl"></i>`;
        e.querySelector("b").textContent = NAMES[b.label] || b.label;
        e.addEventListener("pointerdown", (ev) => (ev.target.classList.contains("grip") ? startSize(ev, b.label) : start(ev, b.label)));
        screen.append(e);
      }
      if (drag && drag.label === b.label) continue;
      e.style.left = `${(b.x - m.x) * k}px`;
      e.style.top = `${(b.y - m.y) * k}px`;
      e.style.width = `${Math.max(24, b.w * k)}px`;
      e.style.height = `${Math.max(14, b.h * k)}px`;
      e.classList.toggle("off", !b.visible);
      e.querySelector("small").textContent = b.visible ? "" : "escondido agora";
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
  const SLIDER = { overlay: ".size", boss: ".bossScale", meter: ".meterScale", party: ".partyScale" };
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
  window.addEventListener("resize", draw);
  setInterval(load, 1000);
  document.querySelector('.tab[data-tab="overlays"]')?.addEventListener("click", () => setTimeout(load, 50));
  load();
})();
