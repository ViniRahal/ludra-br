// The mechanics from the GitHub (download/mecanicas.json), so a fix to a % or
// a new mechanic reaches everyone at once, with no new version of the app.
// Only data comes this way, and only the fields below; the last copy is kept
// so the app starts with it even with no internet.
(function () {
  const DATA = window.LUDRA_BR;
  if (!DATA) return;
  const URL_ = "https://raw.githubusercontent.com/ViniRahal/ludra-br/main/download/mecanicas.json";
  const STORE = "ludra:mecanicas";
  const BOSS_FIELDS = ["name", "short", "codes", "enrage", "skills", "buffs", "hp", "hpHard", "casts", "buffCalls", "onMe", "hardCodes", "normalCodes", "hardMinHp"];
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

  // In place: the engine keeps a reference to these very objects.
  function apply(m) {
    if (!isObj(m) || !isObj(m.bosses)) return false;
    for (const [key, b] of Object.entries(m.bosses)) {
      if (!isObj(b) || !/^[a-z0-9_]+$/.test(key)) continue;
      const own = (DATA.bosses[key] ||= {});
      for (const f of BOSS_FIELDS) if (f in b) own[f] = b[f];
      for (const f of ["skills", "buffs", "hp", "casts"]) if (!Array.isArray(own[f])) own[f] = [];
    }
    if (Number(m.minBossHp) > 0) DATA.minBossHp = Number(m.minBossHp);
    DATA.remoteVersion = m.version || null;
    return true;
  }

  try {
    const cached = JSON.parse(localStorage.getItem(STORE) || "null");
    if (cached) apply(cached);
  } catch {}

  async function refresh() {
    try {
      const r = await fetch(`${URL_}?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;
      const m = await r.json();
      if (apply(m)) {
        try {
          localStorage.setItem(STORE, JSON.stringify(m));
        } catch {}
        window.onMechanicsUpdated?.(m.version);
      }
    } catch {}
  }
  window.refreshMechanics = refresh;
  refresh();
  setInterval(refresh, 30 * 60 * 1000);
})();
