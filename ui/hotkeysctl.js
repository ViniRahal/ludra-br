// "Atalhos de teclado" in the settings window: each action's key, "Mudar"
// (waits for the next key press), "Desligar"/"Ligar", and what a key does
// when it is pressed in the game. The rules are in hotkeys.js; the keys are
// saved and registered with Windows by the program (src/hotkeys.rs, main.rs).
(() => {
  const H = window.LudraHotkeys;
  const T = window.__TAURI__;
  if (!H) return;
  const $ = (s) => document.querySelector(s);
  const inv = (c, a) => (T ? T.core.invoke(c, a) : Promise.reject("sem Tauri"));
  const list = $(".hkList"), note = $(".hkNote");
  // The "what to hide" option and the "hidden now" line: drawn under the
  // row of the key they belong to, not after the whole list.
  const overlaysSub = $(".hkOverlaysSub");
  // How long "Mudar" waits for a key. The program gives the keys back by
  // itself a bit after this (src/main.rs), in case the page never does.
  const WAIT_MS = 30000;
  // Said when the key that opens this window is gone: the way back.
  const NO_OPEN = "Sem essa tecla, abra o Ludra BR pela barra de tarefas do Windows.";
  const ui = { on: $(".hkOn"), announce: $(".hkAnnounce"), overlays: $(".hkOverlays") };
  if (!list) return;

  let p = H.clean(null);
  let status = {}; // action -> { key, state } from Windows
  let hidden = false; // the boxes hidden by the key
  let waiting = null; // the action waiting for a new key
  let rowMsg = {}; // action -> { text, bad } under its row, after a change

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function render() {
    ui.on.checked = p.on;
    ui.announce.checked = p.announce;
    ui.overlays.value = p.overlays;
    ui.overlays.closest(".switch").classList.toggle("dim", !p.keys.overlays);
    for (const h of document.querySelectorAll(".hkHidden")) h.hidden = !hidden;
    list.replaceChildren();
    for (const a of H.ACTIONS) {
      const key = p.keys[a.id];
      const row = el("div", `hkRow${p.on ? "" : " dim"}${waiting === a.id ? " waiting" : ""}`);
      const text = el("div", "hkText");
      text.append(el("b", null, a.name), el("span", "hkDesc", a.desc));
      const chip = el("span", `hkKey${key ? "" : " off"}`);
      if (waiting === a.id) chip.textContent = waitText || "Aperte as teclas…";
      else chip.textContent = key ? H.display(key) : "Desligado";
      const btns = el("div", "hkBtns");
      if (waiting === a.id) {
        const cancel = el("button", "btn", "Cancelar");
        cancel.type = "button";
        cancel.addEventListener("click", () => stopWaiting());
        btns.append(cancel);
      } else {
        const change = el("button", "btn", "Mudar");
        change.type = "button";
        change.addEventListener("click", () => startWaiting(a.id));
        btns.append(change);
        if (key) {
          const off = el("button", "btn", "Desligar");
          off.type = "button";
          off.addEventListener("click", () => {
            rowMsg = a.id === "open" && p.on ? { open: { text: NO_OPEN, bad: true } } : {};
            apply(H.assign(p, a.id, ""));
          });
          btns.append(off);
        } else {
          const sug = H.suggestion(p, a.id);
          const on = el("button", "btn", sug ? `Ligar (${H.display(sug)})` : "Ligar");
          on.type = "button";
          on.addEventListener("click", () => {
            rowMsg = {};
            if (sug) apply(H.assign(p, a.id, sug));
            else startWaiting(a.id);
          });
          btns.append(on);
        }
      }
      row.append(text, chip, btns);
      list.append(row);
      // What Windows said, or what the last change said.
      const winLine = H.statusLine(key, status[a.id], p.on);
      const msg = waiting === a.id ? waitMsg : rowMsg[a.id];
      if (msg && msg.text) list.append(el("p", `note hkMsg${msg.bad ? " bad" : ""}`, msg.text));
      if (winLine && waiting !== a.id) list.append(el("p", "note hkMsg bad", winLine));
      if (a.id === "overlays" && overlaysSub) list.append(overlaysSub);
    }
  }

  // ---- Waiting for a new key -------------------------------------------
  let waitText = "", waitMsg = null, waitTimer = 0;
  function startWaiting(action) {
    if (waiting) stopWaiting(true);
    waiting = action;
    waitText = "Aperte as teclas…";
    waitMsg = { text: "Aperte a combinação (por exemplo Alt + R). Esc cancela." };
    rowMsg = {};
    // Our keys are let go meanwhile, or pressing one would run it.
    inv("hotkeys_pause", { on: true }).catch(() => {});
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => {
      const action = waiting;
      stopWaiting(true);
      rowMsg = action ? { [action]: { text: "Demorou demais. Clique em Mudar de novo.", bad: true } } : {};
      render();
    }, WAIT_MS);
    render();
  }
  function stopWaiting(quiet) {
    if (!waiting) return;
    waiting = null;
    clearTimeout(waitTimer);
    inv("hotkeys_pause", { on: false }).catch(() => {});
    if (!quiet) render();
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (!waiting) return;
      e.preventDefault();
      e.stopPropagation();
      const r = H.fromEvent(e);
      if (r.cancel) return stopWaiting();
      if (r.partial != null) {
        waitText = r.partial || "Aperte as teclas…";
        return render();
      }
      if (r.error) {
        waitMsg = { text: r.error, bad: true };
        return render();
      }
      const c = H.check(r.label, p.keys, waiting);
      if (c.level === "block") {
        waitText = H.display(r.label);
        waitMsg = { text: `${c.msg} Tente outra (Esc cancela).`, bad: true };
        return render();
      }
      const action = waiting;
      waiting = null;
      clearTimeout(waitTimer);
      rowMsg = { [action]: { text: [c.msg, c.moved].filter(Boolean).join(" "), bad: c.level === "warn" } };
      apply(H.assign(p, action, c.label)); // registers again: the pause ends
    },
    true,
  );
  window.addEventListener("keyup", (e) => {
    if (waiting && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      waitText = "Aperte as teclas…";
      render();
    }
  });
  // The window left while waiting: nothing chosen.
  window.addEventListener("blur", () => stopWaiting());

  // ---- Saving ------------------------------------------------------------
  async function apply(next) {
    p = H.clean(next);
    render();
    try {
      const v = await inv("hotkeys_set", { config: p });
      take(v);
      note.textContent = v && v.saveError ? v.saveError : "";
    } catch (e) {
      note.textContent = typeof e === "string" && e !== "sem Tauri" ? e : "Não consegui salvar os atalhos.";
      // The keys may still be paused by "Mudar", and what the program holds
      // may not be what this page shows: give them back and ask again.
      inv("hotkeys_pause", { on: false }).catch(() => {});
      await inv("hotkeys_get").then(take).catch(() => {});
    }
    render();
  }
  function take(v) {
    if (!v) return;
    if (v.config) p = H.clean(v.config);
    if (v.status) status = v.status;
    if (typeof v.hidden === "boolean") hidden = v.hidden;
  }

  ui.on.addEventListener("change", () => {
    rowMsg = !ui.on.checked && p.keys.open ? { open: { text: NO_OPEN, bad: true } } : {};
    apply({ ...p, on: ui.on.checked });
  });
  ui.announce.addEventListener("change", () => apply({ ...p, announce: ui.announce.checked }));
  ui.overlays.addEventListener("change", () => apply({ ...p, overlays: ui.overlays.value }));
  $(".hkReset").addEventListener("click", () => {
    rowMsg = {};
    apply({ ...H.DEFAULTS, keys: { ...H.DEFAULTS.keys } });
  });
  for (const b of document.querySelectorAll(".hkShowAll")) b.addEventListener("click", () => inv("overlays_toggle").then((h) => { hidden = !!h; render(); }).catch(() => {}));

  // ---- A key pressed in the game -------------------------------------------
  // The windows (open, hide the boxes) are moved by the program itself; the
  // rest is this page's, and the big text says what happened, since the
  // player is in the game and can't see this window.
  // Low: a notice never pushes a mechanic call off the screen (plugin.js).
  const tell = (text) => {
    if (p.announce) window.ludraCall?.({ kind: "pre", text, sub: "", say: "", quiet: true, low: true });
  };
  async function act(action) {
    if (action === "record") {
      const r = window.ludraRecord;
      if (!r) return;
      const now = await r.toggle();
      tell(now ? "GRAVANDO" : "GRAVAÇÃO PARADA");
    } else if (action === "names") {
      // "Esconder nomes" says it on the big text by itself (its own switch).
      window.ludraNames?.toggle();
    } else if (action === "test") {
      // Only the big text, and only out of a fight: the Início button also
      // puts a fake boss and meter on screen, which would cover the real ones.
      const shown = await window.ludraTestCall?.();
      if (shown === false) tell("TESTE SÓ FORA DA LUTA");
    }
  }

  if (T) {
    T.event.listen("hotkey-action", (e) => act(e.payload));
    T.event.listen("hotkeys", (e) => {
      take(e.payload);
      render();
    });
    T.event.listen("overlays-hidden", (e) => {
      hidden = !!e.payload;
      render();
      // Hiding everything hides the big text too: nothing to say then.
      if (!hidden) tell("CAIXAS DE VOLTA");
      else if (p.overlays !== "all") tell("CAIXAS ESCONDIDAS");
    });
    inv("hotkeys_get").then((v) => { take(v); render(); }).catch(() => {});
  }
  render();
})();
