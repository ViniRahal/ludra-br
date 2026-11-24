// Recording the fight: Windows' own recorder (Xbox Game Bar) started and
// stopped by the program, by a click or by itself at each pull of the bosses
// the player picked. Game Bar writes into Videos\Captures; when the player
// chose another folder, the finished video goes there, with the fight's log
// next to it (src/record.rs). The rules are in reclogic.js.
(() => {
  const $ = (s) => document.querySelector(s);
  const L = window.LudraRecLogic;
  const inv = (c, a) => window.__TAURI__?.core.invoke(c, a) ?? Promise.reject("sem Tauri");
  const btn = $(".recBtn"), note = $(".recNote");
  const ui = { auto: $(".recAuto"), bosses: $(".recBosses"), tail: $(".recTail"), log: $(".recLog"), day: $(".recDay"), how: $(".recHow"), quality: $(".recQuality"), fps: $(".recFps"), sound: $(".recSound") };
  const HELP = note.textContent;
  const HELP_APP = "Grava a tela onde está o jogo (com os avisos por cima) e o som do PC, direto na pasta escolhida.";
  const STORE = "ludra:rec";
  let rec = null; // { at, auto }
  let stopTimer = 0;
  let defaultDir = "";
  // The last recording's result, kept even when a new recording started
  // before it was ready (a finish can take a while), and across restarts.
  const LAST = "ludra:recLast";
  let last = null; // describe() of the last finish
  try { last = JSON.parse(localStorage.getItem(LAST) || "null"); } catch {}

  // Options: kept on this PC. The first version only had the "by itself" switch.
  let p = L.DEFAULTS;
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "null");
    p = L.clean(raw || { auto: localStorage.getItem("ludra:recAuto") === "1" });
  } catch {}
  const save = () => {
    try { localStorage.setItem(STORE, JSON.stringify(p)); } catch {}
  };

  const showOptions = () => {
    ui.auto.checked = p.auto;
    ui.bosses.value = p.bosses;
    ui.tail.value = String(p.tail);
    ui.tail.dispatchEvent(new Event("input"));
    ui.log.checked = p.log;
    ui.day.checked = p.day;
    ui.how.value = p.how;
    ui.quality.value = p.quality;
    ui.fps.value = String(p.fps);
    ui.sound.checked = p.sound;
    // Quality, frames and sound are the program's recorder's; Game Bar has its own (Windows settings).
    for (const k of ["quality", "fps", "sound"]) ui[k].closest(".switch").hidden = p.how !== "app";
    note.dataset.help = p.how === "app" ? HELP_APP : HELP;
    // The boss list and the seconds only matter when it records by itself.
    ui.bosses.closest(".switch").hidden = !p.auto;
    ui.tail.closest(".row").hidden = !p.auto;
    $(".recDir").textContent = L.shownDir(p, defaultDir, Date.now());
    $(".recDir").title = $(".recDir").textContent;
    $(".recReset").hidden = !p.dir;
  };
  const set = (k, v) => {
    p = L.clean({ ...p, [k]: v });
    save();
    showOptions();
  };
  ui.auto.addEventListener("change", () => set("auto", ui.auto.checked));
  ui.bosses.addEventListener("change", () => set("bosses", ui.bosses.value));
  ui.tail.addEventListener("change", () => set("tail", Number(ui.tail.value)));
  ui.log.addEventListener("change", () => set("log", ui.log.checked));
  ui.day.addEventListener("change", () => set("day", ui.day.checked));
  ui.how.addEventListener("change", () => set("how", ui.how.value));
  ui.quality.addEventListener("change", () => set("quality", ui.quality.value));
  ui.fps.addEventListener("change", () => set("fps", Number(ui.fps.value)));
  ui.sound.addEventListener("change", () => set("sound", ui.sound.checked));

  $(".recPick").addEventListener("click", async () => {
    let dir = null;
    try {
      dir = await inv("record_pick_folder", { start: p.dir || defaultDir || null });
    } catch (e) {
      console.warn("record_pick_folder", e);
      note.textContent = "Não consegui abrir a janela para escolher a pasta.";
      return;
    }
    if (!dir) return; // cancelled
    // Picking Game Bar's own folder is the same as the default.
    const same = defaultDir && dir.replace(/[\\/]+$/, "").toLowerCase() === defaultDir.replace(/[\\/]+$/, "").toLowerCase();
    set("dir", same ? "" : dir);
  });
  $(".recReset").addEventListener("click", () => set("dir", ""));
  // With one folder per day, today's (when a video already went there).
  $(".recFolder").addEventListener("click", () =>
    inv("record_open_folder", { dir: p.dir || null, day: p.day ? L.dayName(Date.now()) : null }).catch(() => {}));

  const show = () => {
    btn.textContent = rec ? "Parar gravação" : "Gravar agora";
    btn.classList.toggle("recording", !!rec);
  };
  // "Gravando desde 15:02. Último vídeo: x.mp4." while a recording runs.
  const recordingLine = () => {
    if (!rec) return "";
    const head = rec.found
      ? `Gravando desde ${new Date(rec.at).toLocaleTimeString("pt-BR")}${rec.auto ? " (pull do boss)" : ""}.`
      : "Gravando, mas não achei a janela do AION 2: o Windows grava a janela que estiver na frente.";
    return last?.short ? `${head} ${last.short}` : head;
  };

  async function start(isAuto) {
    if (rec) return;
    clearTimeout(stopTimer);
    stopTimer = 0;
    rec = { at: Date.now(), auto: isAuto, own: p.how === "app" };
    show();
    const r = rec;
    if (r.own) {
      try {
        r.path = await inv("rec_start", L.startArgs(p, r.at));
        r.found = true;
      } catch (e) {
        if (rec === r) rec = null;
        show();
        note.textContent = `Não consegui começar a gravar: ${e}`;
        return;
      }
      if (rec === r) note.textContent = recordingLine();
      return;
    }
    // The start time goes along: a finish still waiting for the previous
    // video then knows a file made from now on is not that one.
    try { r.found = await inv("record_toggle", { startAt: r.at }); } catch {}
    if (rec === r) note.textContent = recordingLine();
  }

  async function stop() {
    if (!rec) return;
    clearTimeout(stopTimer);
    stopTimer = 0;
    const r = rec;
    rec = null;
    show();
    let done = null;
    if (r.own) {
      note.textContent = "Salvando o vídeo…";
      try { done = await inv("rec_stop"); } catch (e) { done = { problem: String(e) }; }
    } else {
      try { await inv("record_toggle"); } catch {}
    }
    const until = Date.now();
    const lines = p.log && window.ludraLogLines ? window.ludraLogLines(r.at - 5000) : [];
    if (!r.own) note.textContent = p.dir ? "Salvando o vídeo e levando para a sua pasta…" : "Salvando o vídeo…";
    let res = null;
    if (r.own && !done?.video) {
      res = { own: true, problem: done?.problem || "" };
    } else {
      try {
        res = await inv("record_finish", { args: L.finishArgs(p, r.at, until, lines.join("\n"), r.own ? done.video : null) });
        if (r.own && done.problem) res.problem = [res.problem, done.problem].filter(Boolean).join(" ");
      } catch (e) {
        res = { problem: "Não consegui terminar de salvar o vídeo." };
        console.warn("record_finish", e);
      }
    }
    last = L.describe(res);
    try { localStorage.setItem(LAST, JSON.stringify(last)); } catch {}
    console.info("[gravar]", last.line);
    showOptions(); // today's folder may have changed at midnight
    // A new recording already running keeps its line, with this result after it.
    note.textContent = rec ? recordingLine() : last.line;
  }

  btn.addEventListener("click", () => (rec ? stop() : start(false)));
  // For the "Gravar / parar gravação" key (hotkeysctl.js): true when it is
  // recording now. The stop is not waited for (saving takes a while).
  window.ludraRecord = {
    async toggle() {
      if (rec) {
        stop();
        return false;
      }
      await start(false);
      return !!rec;
    },
    get recording() {
      return !!rec;
    },
  };

  // By itself: a pull of a chosen boss starts the recording; the end of the
  // fight (the boss dead or gone, or a wipe back to full) stops it a few
  // seconds later, as many as the player set.
  window.recordState = (s) => {
    if (L.isFight(s, p.bosses)) {
      clearTimeout(stopTimer);
      stopTimer = 0;
      if (!rec && p.auto) start(true);
    } else if (rec && rec.auto && !stopTimer) {
      stopTimer = setTimeout(() => { stopTimer = 0; stop(); }, p.tail * 1000);
    }
  };

  inv("record_default_dir").then((d) => { defaultDir = d || ""; showOptions(); }).catch(() => {});
  showOptions();
  show();
  note.textContent = note.dataset.help || HELP;
})();
