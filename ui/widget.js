// The big text over the game: the boss's HP strip and up to two calls, as the
// page sends them ({ look, items, live }); the seconds counted here.
const stack = document.querySelector(".stack");
let locked = false;
let look = { size: 60, fg: "#ffd84d", bg: "#000000", bgOpacity: 0.8 };
let items = [];
let live = null;

const rgba = (c, a) => {
  const m = /^#([0-9a-f]{6})$/i.exec(c || "");
  const n = m ? parseInt(m[1], 16) : 0;
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const secs = (ms) => {
  const s = ms / 1000;
  return s >= 10 ? `${Math.ceil(s)} s` : `${s.toFixed(1).replace(".", ",")} s`;
};
const clock = (s) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",")} mi` : `${Math.round(n / 1000)} mil`);
// The fight's clock, the group's damage, when it dies at that pace, the enrage.
function stats(l, t) {
  if (!l || !l.pullAt) return [];
  const el = (t - l.pullAt) / 1000;
  const out = [`⏱ ${clock(el)}`];
  if (l.dps > 0) out.push(`${big(l.dps)}/s`, `mata em ${clock(l.cur / l.dps)}`);
  if (l.enrage > 0) out.push(el < l.enrage ? `enrage ${clock(l.enrage - el)}` : "ENRAGE");
  return out;
}
const pctText = (p) => (p == null ? "—" : `${p.toFixed(1).replace(".", ",")}%`);

function style() {
  const r = document.documentElement.style;
  r.setProperty("--s", `${look.size}px`);
  r.setProperty("--fg", look.fg);
  r.setProperty("--bg", rgba(look.bg, look.bgOpacity ?? 0.8));
}

let lastKey = "";
function render() {
  const now = Date.now();
  const calls = items.filter((x) => x.until > now);
  const preview = !calls.length && !live && !locked && window.arrange && arrange.on;
  const key = JSON.stringify([calls.map((x) => [x.kind, x.text, x.sub, !!x.end]), live ? [live.name, live.next?.title] : null, preview]);
  if (key !== lastKey) {
    lastKey = key;
    const kids = [];
    if (live) {
      const hp = document.createElement("div");
      hp.className = "box hp";
      hp.innerHTML = `<div class="hpTop"><span class="who"></span><span class="pct"></span></div><div class="bar"><div class="fill"></div></div><div class="next"></div><div class="stats"></div>`;
      hp.querySelector(".who").textContent = live.short;
      kids.push(hp);
    }
    for (const x of calls) {
      const box = document.createElement("div");
      box.className = `box call ${x.kind}`;
      const big = document.createElement("div");
      big.className = "big";
      const t = document.createElement("span");
      t.textContent = x.text;
      big.append(t);
      if (x.end) {
        big.append(document.createTextNode(" — "));
        const s = document.createElement("span");
        s.className = "secs";
        big.append(s);
      }
      box.append(big);
      if (x.sub) {
        const sub = document.createElement("div");
        sub.className = "sub";
        sub.textContent = x.sub;
        box.append(sub);
      }
      box.dataset.end = String(x.end || 0);
      kids.push(box);
    }
    if (preview) {
      const box = document.createElement("div");
      box.className = "box preview";
      box.innerHTML = `<div class="big">Ludra BR</div><div class="sub">Arraste para onde quiser. Trave nas opções.</div>`;
      kids.push(box);
    }
    stack.replaceChildren(...kids);
  }
  const hp = stack.querySelector(".hp");
  if (hp && live) {
    hp.querySelector(".pct").textContent = `${live.approx ? "≈ " : ""}${pctText(live.pct)}`;
    hp.querySelector(".fill").style.width = `${Math.max(0, Math.min(100, live.pct ?? 0))}%`;
    hp.querySelector(".next").textContent = live.next ? `próxima: ${live.next.title} em ${String(live.next.pct).replace(".", ",")}%` : "";
    hp.querySelector(".stats").textContent = stats(live, now).join(" · ");
  }
  for (const box of stack.querySelectorAll(".call")) {
    const s = box.querySelector(".secs");
    if (s) s.textContent = secs(Math.max(0, Number(box.dataset.end) - now));
  }
  reportArea();
}
setInterval(render, 100);

let lastArea = "";
function reportArea() {
  const areas = [...stack.children].map((b) => {
    const r = b.getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });
  const k = JSON.stringify(areas);
  if (k === lastArea) return;
  lastArea = k;
  if (typeof a2.widget.areas === "function") a2.widget.areas(areas.length ? areas : [{ x: 0, y: 0, width: 1, height: 1 }]).catch(() => {});
  else if (typeof a2.widget.area === "function") a2.widget.area(areas[0] || { x: 0, y: 0, width: 1, height: 1 }).catch(() => {});
}

a2.on("widget", (d) => {
  if (!d) return;
  look = { ...look, ...(d.look || {}) };
  items = Array.isArray(d.items) ? d.items : [];
  live = d.live || null;
  style();
  render();
});
window.arrange && arrange.listen(() => render());
a2.on("locked", (on) => {
  locked = !!on;
  render();
});

// A press becomes a drag once the pointer moves; a double-click opens the settings.
let press = null;
let lastClick = 0;
stack.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || locked || !e.target.closest(".box")) return;
  e.preventDefault();
  press = { x: e.screenX, y: e.screenY };
});
document.addEventListener("mousemove", (e) => {
  if (!press) return;
  if (!(e.buttons & 1)) return void (press = null);
  if (Math.abs(e.screenX - press.x) + Math.abs(e.screenY - press.y) >= 4) {
    press = null;
    lastClick = 0;
    a2.widget.drag().catch(() => {});
  }
});
document.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || !press) return;
  press = null;
  const now = Date.now();
  if (now - lastClick <= 400) {
    lastClick = 0;
    a2.widget.post({ open: true }).catch(() => {});
  } else lastClick = now;
});
document.addEventListener("contextmenu", (e) => e.preventDefault());

style();
a2.ready();
// Sent before this page had loaded (just opened): ask again.
a2.widget.post({ hello: true }).catch(() => {});
