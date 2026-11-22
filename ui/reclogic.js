// The rules of the fight recording, with no page in them (tests/record.test.mjs):
// the player's options, which bosses start it by themselves, and the names.
(() => {
  const DEFAULTS = {
    auto: false, // record each pull by itself
    bosses: "ludra", // which pulls: see BOSSES
    tail: 8, // seconds kept after the fight ends (the death, the loot)
    log: true, // the fight's log saved next to the video
    day: false, // one folder per day inside the chosen one
    dir: "", // the chosen folder; empty: Game Bar's own (Videos\Captures)
  };
  const BOSSES = {
    ludra: ["ludra"],
    trio: ["ludra", "rahu", "ketu"],
    all: ["reator", "ludra", "rahu", "ketu"],
  };
  const TAIL_MIN = 3, TAIL_MAX = 30;

  // Whatever was stored (an older version, a hand edit), back to sane values.
  function clean(raw) {
    const p = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
    p.auto = !!p.auto;
    p.log = !!p.log;
    p.day = !!p.day;
    if (!BOSSES[p.bosses]) p.bosses = DEFAULTS.bosses;
    const t = Math.round(Number(p.tail));
    p.tail = Number.isFinite(t) ? Math.min(TAIL_MAX, Math.max(TAIL_MIN, t)) : DEFAULTS.tail;
    p.dir = typeof p.dir === "string" ? p.dir.trim() : "";
    return p;
  }

  // A pull of one of the chosen bosses going on (pulled, not dead or reset).
  function isFight(s, bosses) {
    return !!(s && s.pullAt && s.cur > 0 && (BOSSES[bosses] || BOSSES.ludra).includes(s.key));
  }

  const pad = (n) => String(n).padStart(2, "0");
  const dayName = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const stamp = (t) => {
    const d = new Date(t);
    return `${dayName(t)} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  };

  // The finish call's arguments, from the options at the time it stops.
  function finishArgs(p, since, until, logText) {
    return {
      since, until,
      dir: p.dir,
      day: p.day ? dayName(since) : "",
      log: p.log && logText ? logText : null,
      logName: `Ludra BR registro ${stamp(since)}.txt`,
    };
  }

  // The folder shown under "Onde salvar": where the next video will really
  // land, today's folder included.
  function shownDir(p, defaultDir, now) {
    const base = p.dir || defaultDir || "Vídeos\\Captures";
    const path = p.day ? `${base.replace(/[\\/]+$/, "")}\\${dayName(now)}` : base;
    const notes = [p.dir ? "" : "padrão do Windows", p.day ? "uma pasta por dia" : ""].filter(Boolean);
    return notes.length ? `${path} (${notes.join(", ")})` : path;
  }

  const fileOf = (path) => String(path).split(/[\\/]/).pop();
  const folderOf = (path) => String(path).replace(/[\\/][^\\/]*$/, "");

  // What a finished recording says: { line, short, problem }. `line` is the
  // whole message when nothing is recording; `short` goes after "Gravando
  // desde..." when a new recording already started; a problem is always told.
  function describe(res) {
    const problem = res?.problem ? String(res.problem) : "";
    const logNote = res?.log ? " O registro da luta foi salvo junto." : "";
    if (res?.video) {
      const mb = Math.round((Number(res.bytes) || 0) / 1e6);
      return {
        line: `Vídeo salvo em ${folderOf(res.video)}: ${fileOf(res.video)} (${mb} MB).${logNote}${problem ? ` ${problem}` : ""}`,
        short: `Último vídeo: ${fileOf(res.video)}.${problem ? ` ${problem}` : ""}`,
        problem,
      };
    }
    const miss = "Não achei o vídeo novo em Vídeos\\Captures. Veja se a Xbox Game Bar está ligada (Configurações do Windows > Jogos) ou se você mudou a pasta Capturas do Windows.";
    const logWhere = res?.log ? ` O registro da luta foi salvo em ${folderOf(res.log)}.` : "";
    return {
      line: `${miss}${logWhere}${problem ? ` ${problem}` : ""}`,
      short: `Último vídeo: não achei.${problem ? ` ${problem}` : ""}`,
      problem: problem || miss,
    };
  }

  window.LudraRecLogic = { DEFAULTS, BOSSES, TAIL_MIN, TAIL_MAX, clean, isFight, dayName, stamp, finishArgs, shownDir, describe, fileOf, folderOf };
})();
