// "O que te matou": the words for a death recap, as the meter sends it
// ({ seq, id, name, class, me, at_ms, killer, skill, skill_id, damage,
// window_ms, taken, hits: [{ before_ms, from, skill, damage }] }).
// Only text here (no page): the big text, the deaths line, the Resumo and
// the Registro all take their words from these.
(function (root) {
  const num = (n) => {
    n = Math.max(0, Number(n) || 0);
    if (n < 1000) return String(Math.round(n));
    if (n < 999_500) return `${Math.round(n / 1000)} mil`;
    const m = n / 1e6;
    return `${(m >= 10 ? Math.round(m).toString() : m.toFixed(1).replace(/\.0$/, "").replace(".", ","))} mi`;
  };
  const secs = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1).replace(".", ",")} s`;
  const clock = (ms) => {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const blow = (r) => (r && String(r.skill || "").trim()) || "golpe desconhecido";
  const by = (r) => (r && String(r.killer || "").trim() ? ` (${String(r.killer).trim()})` : "");

  // The big text when you die: "VOCÊ MORREU — Raio em linha (Ludra)".
  const headline = (r) => `VOCÊ MORREU — ${blow(r)}${by(r)}`;
  // Under it: "85 mil · em 2,1 s" (the killing blow, and how fast it all went).
  const detail = (r) => {
    const out = [];
    if (r && r.damage > 0) out.push(num(r.damage));
    if (r && r.window_ms > 0) out.push(`em ${secs(r.window_ms)}`);
    if (r && r.taken > 0 && r.taken !== r.damage) out.push(`levou ${num(r.taken)} no total`);
    return out.join(" · ");
  };
  // The last hits, newest last: "-1,2 s  Cone (Ludra)  40 mil".
  const lines = (r, max = 5) =>
    ((r && Array.isArray(r.hits) ? r.hits : []).slice(-max)).map((h) => {
      const from = String(h.from || "").trim();
      return `-${secs(h.before_ms)}  ${(String(h.skill || "").trim()) || "golpe desconhecido"}${from ? ` (${from})` : ""}  ${num(h.damage)}`;
    });
  const voice = (r) => (r && String(r.skill || "").trim() ? `Você morreu para ${String(r.skill).trim()}` : "Você morreu");
  // Someone of the party: "Raio em linha (85 mil)".
  const short = (r) => `${blow(r)}${r && r.damage > 0 ? ` (${num(r.damage)})` : ""}`;
  // The Resumo: "12:31 Fulano — Raio em linha (85 mil, 2,1 s)", and the
  // mechanic just before when it is not the same thing.
  const summary = (d) => {
    const k = d.kill;
    let s = `${clock(d.t)} ${d.name}`;
    if (k) {
      const parts = [k.damage > 0 ? num(k.damage) : "", k.window_ms > 0 ? secs(k.window_ms) : ""].filter(Boolean);
      s += ` — ${blow(k)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
      if (d.mech && d.mech.toLowerCase() !== blow(k).toLowerCase()) s += ` · durante ${d.mech}`;
    } else if (d.mech) s += ` (${d.mech})`;
    return s;
  };
  // One Registro line, tab-separated like the mechanics' lines.
  const logLine = (r, at) =>
    [
      new Date(at).toISOString(),
      "MORTE",
      `${r.name || "?"}${r.me ? " (você)" : ""}: ${blow(r)}${by(r)}`,
      r.skill_id || "",
      r.damage || 0,
      r.window_ms > 0 ? `${(r.window_ms / 1000).toFixed(1)}s` : "",
      r.taken || 0,
      (r.hits || []).map((h) => `-${((h.before_ms || 0) / 1000).toFixed(1)}s ${h.skill || "?"}${h.from ? `/${h.from}` : ""} ${h.damage || 0}`).join(" | "),
    ].join("\t");

  root.LudraRecap = { num, secs, clock, blow, headline, detail, lines, voice, short, summary, logLine };
})(typeof window !== "undefined" ? window : globalThis);
