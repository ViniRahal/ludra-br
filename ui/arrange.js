// Whether the player is in the program (its settings, or dragging a box)
// rather than in the game: only then do the empty boxes show, to be placed.
// Out of the program they stay hidden until the fight starts. A short grace
// keeps a box from vanishing while focus passes from one window to another.
(function () {
  const T = window.__TAURI__;
  const hs = [];
  let on = false, timer = 0;
  const set = (v) => {
    clearTimeout(timer);
    if (v) {
      on = true;
      hs.forEach((h) => h(true));
    } else
      timer = setTimeout(() => {
        on = false;
        hs.forEach((h) => h(false));
      }, 600);
  };
  window.arrange = {
    get on() { return on; },
    listen: (h) => hs.push(h),
  };
  if (T) {
    T.event.listen("arrange", (e) => set(!!e.payload));
    T.core.invoke("arranging").then((v) => set(!!v)).catch(() => {});
  }
})();
