// "Personagens": every character the program has recognised (after a TP or
// a login), kept on this computer, with the class, level, CP and GS the game
// last stated. Also the greeting and the "game running" pills.
(function () {
  const T = window.__TAURI__;
  const NAMES = { templar: "Templário", gladiator: "Gladiador", cleric: "Clérigo", chanter: "Chanter", spiritmaster: "Espiritualista", sorcerer: "Feiticeiro", ranger: "Arqueiro", assassin: "Assassino", fighter: "Lutador" };
  const COLORS = { templar: "#5b8cff", gladiator: "#3cc8f0", cleric: "#f0c24a", chanter: "#ff9a3c", spiritmaster: "#e070e0", sorcerer: "#a07cff", ranger: "#3fd6b0", assassin: "#5fdc6a", fighter: "#ff6a6a" };
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem("ludra:chars") || "{}") || {};
    } catch {
      return {};
    }
  };
  const save = () => {
    try {
      localStorage.setItem("ludra:chars", JSON.stringify(chars));
    } catch {}
  };
  let chars = load();
  let current = null;
  let shown = null;
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0)).replace(".", ",");
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const icon = (cls, size) => {
    if (!cls || cls === "fighter") return el("span", "cIcon", (NAMES[cls] || "?").slice(0, 1));
    const i = el("img", "cIcon");
    i.src = `classes/${cls}.png`;
    i.alt = NAMES[cls] || "";
    if (size) i.style.width = i.style.height = `${size}px`;
    return i;
  };
  function greet() {
    const h = new Date().getHours();
    const part = h < 5 ? "Boa noite" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
    const hello = document.querySelector(".hello");
    if (hello) hello.textContent = current ? `${part}, ${current}` : part;
    const who = document.querySelector(".whoPill");
    if (who) {
      const c = current && chars[current];
      who.textContent = c ? `${c.name}${c.cp ? ` · CP ${short(c.cp)}` : ""}` : "Personagem: dê um TP";
      who.classList.toggle("ok", !!c);
    }
  }
  function render() {
    const list = Object.values(chars).sort((a, b) => (b.seen || 0) - (a.seen || 0));
    const tabs = document.querySelector(".charTabs");
    const head = document.querySelector(".charHead");
    const stats = document.querySelector(".charStats");
    if (!tabs) return;
    if (!shown || !chars[shown]) shown = current || (list[0] && list[0].name) || null;
    tabs.replaceChildren();
    for (const c of list) {
      const b = el("button", `charTab${c.name === shown ? " isActive" : ""}`);
      b.type = "button";
      b.append(icon(c.class, 18), el("span", "", c.name));
      if (c.name === current) b.append(el("i", "dot"));
      b.addEventListener("click", () => {
        shown = c.name;
        render();
      });
      tabs.append(b);
    }
    head.replaceChildren();
    stats.replaceChildren();
    const c = shown && chars[shown];
    if (!c) {
      head.append(el("h2", "", "Personagens"));
      return;
    }
    const big = icon(c.class, 44);
    const txt = el("div");
    txt.append(el("h2", "", c.name));
    const sub = [NAMES[c.class], c.level ? `Nv. ${c.level}` : "", c.server ? `Servidor ${c.server}` : ""].filter(Boolean).join("   ");
    txt.append(el("div", "charSub", sub));
    head.append(big, txt);
    head.style.setProperty("--c", COLORS[c.class] || "#8fc2ff");
    const box = (label, value, cls) => {
      const b = el("div", "stat");
      b.append(el("div", "statLabel", label), el("div", `statValue ${cls || ""}`, value));
      stats.append(b);
    };
    box("Poder de combate", c.cp ? short(c.cp) : "—", "blue");
    box("Gear score", c.gs ? c.gs.toLocaleString("pt-BR") : "—");
    box("Classe", NAMES[c.class] || "—");
    box("Visto por último", c.seen ? new Date(c.seen).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
  }
  function onMe(me) {
    if (!me || !me.name) return;
    const old = chars[me.name] || {};
    const c = {
      name: me.name,
      class: me.class || old.class || "",
      cp: me.cp || old.cp || 0,
      gs: me.gs || old.gs || 0,
      level: me.level || old.level || 0,
      server: me.server || old.server || 0,
      seen: Date.now(),
    };
    const changed = current !== me.name || ["class", "cp", "gs", "level", "server"].some((k) => c[k] !== old[k]);
    chars[me.name] = c;
    if (current !== me.name) shown = me.name;
    current = me.name;
    if (changed) {
      save();
      render();
      greet();
    }
  }
  T && T.event.listen("meter", (e) => onMe(e.payload && e.payload.me));
  // The "Aion 2 está em execução" pills.
  const pills = (on) => {
    for (const p of document.querySelectorAll(".gamePill")) {
      p.classList.toggle("ok", on);
      p.querySelector("span").textContent = on ? "Aion 2 está em execução" : "Esperando o jogo";
    }
  };
  a2.on("status", (s) => pills(!!(s && s.game)));
  T && T.core.invoke("status").then((s) => s && pills(!!s.game)).catch(() => {});
  T && T.app && T.app.getVersion().then((v) => { const e = document.querySelector(".ver"); if (e) e.textContent = `v${v}`; }).catch(() => {});
  render();
  greet();
  setInterval(greet, 60000);
})();
// Each slider shows its value, as a %.
for (const r of document.querySelectorAll('.row input[type="range"]')) {
  const v = document.createElement("span");
  v.className = "rangeVal";
  r.after(v);
  const show = () => (v.textContent = `${r.value}%`);
  r.addEventListener("input", show);
  setTimeout(show, 300);
}
