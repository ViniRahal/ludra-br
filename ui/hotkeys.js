// The rules of "Atalhos de teclado", with no page in them
// (tests/hotkeys.test.mjs): the actions, the player's options, turning a key
// press into a key's name, and which keys are a bad idea. The names are the
// ones src/hotkeys.rs reads (it registers them with Windows).
(() => {
  const ACTIONS = [
    { id: "open", name: "Abrir o Ludra BR", desc: "Abre esta janela por cima do jogo. Aperte de novo para voltar ao jogo.", suggest: "Alt+E" },
    { id: "record", name: "Gravar / parar gravação", desc: "Começa ou para a gravação (aba Vídeo e live).", suggest: "Alt+Shift+R" },
    { id: "overlays", name: "Esconder / mostrar as caixas", desc: "Some com as caixas (overlays) que ficam por cima do jogo. Aperte de novo para voltar.", suggest: "Alt+Shift+H" },
    { id: "names", name: "Esconder nomes", desc: "Liga ou desliga o Esconder nomes (para gravar ou fazer live).", suggest: "Alt+Shift+N" },
    { id: "test", name: "Testar aviso", desc: "Mostra um Bingo de mentira na tela, para ver onde ele aparece.", suggest: "Alt+Shift+T" },
  ];
  const OVERLAYS = ["all", "meter", "keepCalls"];

  // Only the key that always opened the settings is on at first: any other
  // key taken without the player asking could be one the game uses.
  const DEFAULTS = {
    on: true, // all the keys at once
    announce: true, // say on the big text what a key did
    overlays: "all", // what "esconder as caixas" hides: see OVERLAYS
    keys: { open: "Alt+E", record: "", overlays: "", names: "", test: "" },
  };

  // KeyboardEvent.code -> our key name. Letters and numbers by their place
  // on the keyboard, so the Brazilian layout gives the same names.
  const CODE = {
    Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Escape: "Esc", Pause: "Pause", ScrollLock: "ScrollLock",
    Insert: "Insert", Delete: "Delete", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    NumpadMultiply: "NumMul", NumpadAdd: "NumAdd", NumpadSubtract: "NumSub", NumpadDecimal: "NumDecimal", NumpadDivide: "NumDiv",
  };
  const NAMED = [...Object.values(CODE), ..."0123456789".split("").map((d) => `Num${d}`)];
  const MODS = ["Ctrl", "Alt", "Shift"];
  const MOD_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$|^AltGraph$/;

  function keyName(code) {
    if (!code) return "";
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
    if ((m = /^Numpad([0-9])$/.exec(code))) return `Num${m[1]}`;
    if ((m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code))) return `F${m[1]}`;
    return CODE[code] || "";
  }

  // "ctrl+shift+r" -> { mods: ["Ctrl","Shift"], key: "R" }, null when not a key.
  function split(label) {
    const parts = String(label || "").split("+").map((x) => x.trim()).filter(Boolean);
    const mods = new Set();
    let key = "";
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low === "ctrl" || low === "control") mods.add("Ctrl");
      else if (low === "alt") mods.add("Alt");
      else if (low === "shift") mods.add("Shift");
      else if (low === "win" || low === "super") mods.add("Win");
      else {
        if (key) return null;
        const up = p.toUpperCase();
        const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(up);
        const named = NAMED.find((n) => n.toLowerCase() === low);
        if (/^[A-Z0-9]$/.test(up)) key = up;
        else if (f) key = `F${f[1]}`;
        else if (named) key = named;
        else return null;
      }
    }
    return key ? { mods: [...MODS, "Win"].filter((x) => mods.has(x)), key } : null;
  }
  const join = (s) => [...s.mods, s.key].join("+");
  // The one way a key is written: Ctrl, Alt, Shift, then the key.
  const normal = (label) => {
    const s = split(label);
    return s ? join(s) : "";
  };

  // A key press while waiting for a new key: { label } once a real key came
  // with it, { partial } while only Ctrl/Alt/Shift are held, { cancel } for
  // a plain Esc.
  function fromEvent(e) {
    const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
    if (MOD_CODES.test(e.code || "") || ["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(e.key)) return { partial: mods.length ? `${mods.join("+")}+…` : "" };
    if (e.metaKey) return { error: "A tecla do Windows é do Windows. Use Ctrl, Alt ou Shift." };
    const key = keyName(e.code);
    if (key === "Esc" && !mods.length) return { cancel: true };
    if (!key) return { error: "Essa tecla não dá para usar. Tente uma letra, um número ou F1 a F12, junto com Alt ou Ctrl." };
    return { label: [...mods, key].join("+") };
  }

  const TYPING = /^([A-Z0-9]|Space|Enter|Tab|Backspace|Esc|Num.+)$/;
  // Windows' own keys (Alt+Tab, Alt+F4, Ctrl+Esc, Ctrl+Shift+Esc,
  // Ctrl+Alt+Del…): taking them would break Windows itself. The same rule as
  // allowed() in src/hotkeys.rs, plus Ctrl+Alt+Tab.
  const windowsKey = (s) => {
    const ctrl = s.mods.includes("Ctrl"), alt = s.mods.includes("Alt");
    return (alt && !ctrl && ["Tab", "F4", "Esc", "Space"].includes(s.key)) || (ctrl && !alt && s.key === "Esc") || (ctrl && alt && (s.key === "Delete" || s.key === "Tab"));
  };
  // Copy, paste and friends: taken, they stop working in every program.
  const EDIT = ["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z", "Ctrl+Y", "Ctrl+S", "Ctrl+F"];
  // On the Brazilian keyboard Ctrl+Alt is AltGr: Q and W write / and ?,
  // which the game's chat needs.
  const ALTGR_NEEDED = ["Ctrl+Alt+Q", "Ctrl+Alt+W"];

  // Is this key a good idea for this action? { level: "block" } can't be
  // used; { level: "warn" } can, with a word of caution; { other } names the
  // action that has it now (it moves here).
  function check(label, keys, action) {
    const s = split(label);
    if (!s) return { level: "block", msg: "Essa tecla não dá para usar." };
    const l = join(s);
    const has = (m) => s.mods.includes(m);
    if (has("Win")) return { level: "block", msg: "A tecla do Windows é do Windows. Use Ctrl, Alt ou Shift." };
    if (TYPING.test(s.key) && !has("Ctrl") && !has("Alt"))
      return { level: "block", msg: "Assim você não conseguiria mais digitar essa tecla no chat. Junte com Alt ou Ctrl." };
    if (windowsKey(s)) return { level: "block", msg: `${l} é do Windows. Escolha outra.` };
    if (EDIT.includes(l)) return { level: "block", msg: `${l} é copiar, colar ou parecido: ia parar de funcionar em tudo. Escolha outra.` };
    if (ALTGR_NEEDED.includes(l)) return { level: "block", msg: `No teclado brasileiro, ${l} escreve / ou ? no chat. Escolha outra.` };
    const other = ACTIONS.find((a) => a.id !== action && normal(keys?.[a.id]) === l);
    const out = { level: null, msg: "", label: l, other: other ? other.id : null };
    if (other) out.moved = `Saiu de "${other.name}", que ficou desligado.`;
    if (l === "Alt+Enter") return { ...out, level: "warn", msg: "Alt+Enter costuma trocar o jogo entre janela e tela cheia." };
    if (!s.mods.length) return { ...out, level: "warn", msg: "O jogo pode usar essa tecla sozinha. Se der problema, junte com Alt ou Ctrl." };
    if (has("Ctrl") && has("Alt") && !has("Shift") && /^[A-Z0-9]$/.test(s.key))
      return { ...out, level: "warn", msg: "No teclado brasileiro, Ctrl+Alt é o AltGr: pode parar de escrever algum símbolo (como ° ou ¹)." };
    if (s.mods.length === 1 && /^[0-9]$/.test(s.key)) return { ...out, level: "warn", msg: "O jogo pode usar essa tecla na barra de habilidades." };
    return out;
  }

  // Whatever was stored (an older version, a hand edit), back to sane
  // values: bad keys off, a key used twice kept by the first action only.
  function clean(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const keysIn = r.keys && typeof r.keys === "object" ? r.keys : {};
    const keys = {};
    const used = new Set();
    for (const a of ACTIONS) {
      const k = a.id in keysIn ? normal(keysIn[a.id]) : DEFAULTS.keys[a.id];
      const ok = k && check(k, {}, a.id).level !== "block" && !used.has(k);
      keys[a.id] = ok ? k : "";
      if (ok) used.add(k);
    }
    return {
      on: typeof r.on === "boolean" ? r.on : DEFAULTS.on,
      announce: typeof r.announce === "boolean" ? r.announce : DEFAULTS.announce,
      overlays: OVERLAYS.includes(r.overlays) ? r.overlays : DEFAULTS.overlays,
      keys,
    };
  }

  // A new key for an action; the action that had it is left without one.
  function assign(p, action, label) {
    const l = normal(label);
    const keys = { ...p.keys };
    for (const a of ACTIONS) if (l && a.id !== action && keys[a.id] === l) keys[a.id] = "";
    keys[action] = l;
    return { ...p, keys };
  }

  // How a key is shown: the names a player knows.
  const SHOW = { Space: "Espaço", Up: "↑", Down: "↓", Left: "←", Right: "→", Delete: "Del", Insert: "Ins", PageUp: "Page Up", PageDown: "Page Down", NumMul: "Num *", NumAdd: "Num +", NumSub: "Num -", NumDiv: "Num /", NumDecimal: "Num ,", Esc: "Esc" };
  function display(label) {
    const s = split(label);
    if (!s) return "";
    const k = SHOW[s.key] || s.key.replace(/^Num(\d)$/, "Num $1");
    return [...s.mods, k].join(" + ");
  }

  // The line under an action, from what Windows said ({ key, state }).
  function statusLine(chosen, st, allOn) {
    if (!allOn || !chosen) return "";
    if (!st) return "";
    if (st.state === "taken") return `Outro programa já usa ${display(chosen)}. Escolha outra tecla.`;
    if (st.state === "bad") return "Essa tecla não dá para usar. Escolha outra.";
    if (st.state === "ok" && st.key && normal(st.key) !== normal(chosen))
      return `Outro programa já usa ${display(chosen)} (o Questlog, por exemplo). Por isso está em ${display(st.key)}.`;
    return "";
  }

  // The suggestion for "Ligar", when no other action has it.
  function suggestion(p, action) {
    const a = ACTIONS.find((x) => x.id === action);
    if (!a) return "";
    const taken = ACTIONS.some((x) => x.id !== action && normal(p.keys[x.id]) === a.suggest);
    return taken ? "" : a.suggest;
  }

  const api = { ACTIONS, OVERLAYS, DEFAULTS, keyName, split, normal, fromEvent, check, clean, assign, display, statusLine, suggestion };
  window.LudraHotkeys = api;
})();
