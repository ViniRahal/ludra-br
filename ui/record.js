// Recording the fight: Windows' own recorder (Xbox Game Bar) started and
// stopped by the program, by a click or by itself at each Ludra pull. The
// fight's log is saved next to the video with the same time in its name.
(() => {
  const $ = (s) => document.querySelector(s);
  const inv = (c, a) => window.__TAURI__?.core.invoke(c, a) ?? Promise.reject("sem Tauri");
  const btn = $(".recBtn"), note = $(".recNote"), auto = $(".recAuto");
  const HELP = note.textContent;
  const STOP_AFTER_MS = 8000; // the end of the fight, a few seconds on
  let rec = null; // { at, auto }
  let stopTimer = 0;

  try { auto.checked = localStorage.getItem("ludra:recAuto") === "1"; } catch {}
  auto.addEventListener("change", () => {
    try { localStorage.setItem("ludra:recAuto", auto.checked ? "1" : "0"); } catch {}
  });

  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  };
  const show = () => {
    btn.textContent = rec ? "Parar gravação" : "Gravar agora";
    btn.classList.toggle("recording", !!rec);
  };

  async function start(isAuto) {
    if (rec) return;
    clearTimeout(stopTimer);
    rec = { at: Date.now(), auto: isAuto };
    show();
    let found = false;
    try { found = await inv("record_toggle"); } catch {}
    note.textContent = found
      ? `Gravando desde ${new Date(rec.at).toLocaleTimeString("pt-BR")}${isAuto ? " (pull do Ludra)" : ""}.`
      : "Gravando, mas não achei a janela do AION 2: o Windows grava a janela que estiver na frente.";
  }

  async function stop() {
    if (!rec) return;
    clearTimeout(stopTimer);
    const r = rec;
    rec = null;
    show();
    try { await inv("record_toggle"); } catch {}
    const lines = window.ludraLogLines ? window.ludraLogLines(r.at - 5000) : [];
    let logNote = "";
    if (lines.length) {
      try {
        await inv("record_save_log", { name: `Ludra BR registro ${stamp(r.at)}.txt`, text: lines.join("\n") });
        logNote = " O registro da luta foi salvo junto.";
      } catch {}
    }
    note.textContent = "Salvando o vídeo…";
    // Game Bar finishes the file a few seconds after it stops.
    setTimeout(async () => {
      let last = null;
      try { last = await inv("record_last"); } catch {}
      note.textContent = last && last.age < 20
        ? `Vídeo salvo: ${last.name} (${Math.round(last.bytes / 1e6)} MB).${logNote}`
        : `Não achei o vídeo novo. Veja se a Xbox Game Bar está ligada (Configurações do Windows > Jogos > Xbox Game Bar).${logNote}`;
    }, 6000);
  }

  btn.addEventListener("click", () => (rec ? stop() : start(false)));
  $(".recFolder").addEventListener("click", () => inv("record_open_folder").catch(() => {}));

  // By itself: a Ludra pull starts the recording; the end of the fight (the
  // boss dead or gone, or a wipe back to full) stops it a few seconds later.
  window.recordState = (s) => {
    const fighting = !!(s && s.key === "ludra" && s.pullAt && s.cur > 0);
    if (fighting) {
      clearTimeout(stopTimer);
      stopTimer = 0;
      if (!rec && auto.checked) start(true);
    } else if (rec && rec.auto && !stopTimer) {
      stopTimer = setTimeout(() => { stopTimer = 0; stop(); }, STOP_AFTER_MS);
    }
  };
  show();
  note.textContent = HELP;
})();
