// Ludra BR: the rules, with no page or meter in them, so they can be tested
// (tests/logic.test.mjs). plugin.js feeds it the decoded records and gives it
// the voice, the big text and the storage.
//
// What it reads:
//  - npc-hp (00 8D): entity, kind, count, res, hp. Only the one-entry HP
//    record `02 01 00 <u32 hp> 00 00 00 00` is read (the meter's own test,
//    stream_processor.rs); the player's own (01 01 01), other resources (FP,
//    MP) and sheets are dropped. Other players' HP comes the same way, so
//    nothing under a boss's size (data.minBossHp) is kept, not even a moment.
//  - boss-cast / boss-skill (09 38 / 02 38): caster, skill. Only the skill ids
//    in data.js are looked at; everything else is dropped at once. A 09 38
//    also brings target, target_name, target_me, ms and skill_name (main.rs),
//    for the boss cast bar.
//  - boss-buff (2A 38): entity, abnormal. Same: only data.js's ids.
//
// A monster's HP is kept only for a few seconds (to know the boss's HP the
// moment it is recognised), and only the boss's after that.
(function (root) {
  const KEEP_MS = 20_000; // a monster's last HP, kept this long until it turns out to be the boss
  const STALE_MS = 3_000; // events older than this (queued while the window was shut) are not called
  const RESET_PCT = 98; // back above this after going under 90: a wipe, a new pull
  const MAX_LOG = 3000;
  const GONE_MS = 60_000; // no HP at all this long: the fight is over (a boss can sit still through a phase)
  const LOST_MS = 15_000; // no HP from the boss this long: gone (a reset that respawned it)
  const USE_AFTER_CAST_MS = 10_000; // a 02 38 this long after the same skill's 09 38: the same cast going off
  // The boss cast bar (an idea from Aion-DPS-Meter's "Boss cast bar", MIT):
  const BAR_DEFAULT_MS = 3_000; // a cast whose time neither data.js nor the packet gives
  const BAR_MAX = 3; // casts shown at once (the newest)
  const BAR_KEEP = 12; // live casts the engine holds, known and unknown together
  const BAR_END_AFTER_MS = 500; // a 02 38 of the same skill this long after its 09 38: the cast went off, its bar ends

  function inRanges(id, ranges) {
    for (const [a, b] of ranges) if (id >= a && id <= b) return true;
    return false;
  }

  function createEngine(data, hooks) {
    const now = hooks.now || (() => Date.now());
    const bosses = data.bosses;
    let prefs = { prewarn: 3, hpCalls: true, castCalls: true, thresholds: {}, maxHp: {}, sizes: {}, off: {}, enrage: {} };
    const DPS_WINDOW_MS = 20_000; // the group's damage per second: over this long

    const npc = new Map(); // entity -> { hp, at }, monsters only, a few seconds
    const spawnMax = new Map(); // entity -> max HP, from its spawn (the game's own number)
    const spawnKey = new Map(); // entity -> boss key, from its spawn's model code (data.js `codes`)
    const spawnCode = new Map(); // entity -> its model code (Normal and Hard differ)
    function bossOfCode(code) {
      for (const [key, b] of Object.entries(bosses)) if ((b.codes || []).includes(code)) return key;
      return null;
    }
    let boss = null; // { id, key, max, maxFromPeak, cur, pct, low, fired:Set, seen:{skill:n}, start }
    let bars = []; // the boss cast bar: { id, caster, skill, title, sub, known, start, end, target, targetMe, targetNpc }
    let log = []; // { at, boss, what, pct }

    function setPrefs(p) {
      prefs = { ...prefs, ...(p || {}) };
    }
    function getLog() {
      return log.slice();
    }
    function setLog(l) {
      log = Array.isArray(l) ? l.slice(-MAX_LOG) : [];
    }

    function bossOfSkill(skill) {
      for (const [key, b] of Object.entries(bosses)) if (inRanges(skill, b.skills)) return key;
      return null;
    }
    function bossOfBuff(abnormal) {
      for (const [key, b] of Object.entries(bosses)) if ((b.buffs || []).includes(abnormal)) return key;
      return null;
    }
    function thresholds(key) {
      const b = bosses[key];
      if (!b) return [];
      const own = prefs.thresholds[key] || {};
      // Hard's own numbers when data.js has them (`hpHard`), else the same.
      const list = boss && boss.key === key && b.hpHard && difficulty() === "hard" ? b.hpHard : b.hp;
      return list
        .filter((t) => !prefs.off[`${key}:${t.id}`])
        .map((t) => ({ ...t, pct: Number.isFinite(Number(own[t.id])) ? Number(own[t.id]) : t.pct }))
        .sort((x, y) => y.pct - x.pct);
    }

    // The boss's max HP: the one saved for this boss that fits (Normal and
    // Hard differ), else the highest HP seen this fight (good to well under 1%
    // once the first hit lands at the pull).
    function pickMax(key, hp) {
      const known = (prefs.maxHp[key] || []).filter((m) => m >= hp && hp >= m * 0.6).sort((a, b) => a - b);
      return known.length ? { max: known[0], fromPeak: false } : { max: hp, fromPeak: true };
    }
    function rememberMax(key, max) {
      if (!key || !(max > 0)) return; // a "Chefe" not yet named: nothing to keep it under
      const list = (prefs.maxHp[key] || []).filter((m) => Math.abs(m - max) / max > 0.02);
      list.push(max);
      prefs.maxHp = { ...prefs.maxHp, [key]: list.slice(-4) };
      hooks.savePrefs?.(prefs);
    }

    // The max the spawn gave, when it was seen; else the saved one or the peak.
    function maxFor(id, key, hp) {
      const s = spawnMax.get(id);
      if (s > 0 && (!(hp > 0) || hp <= s)) return { max: s, fromPeak: false };
      return hp > 0 ? pickMax(key, hp) : { max: 0, fromPeak: true };
    }

    // Normal or Hard: from the spawn's model code when data.js knows it
    // (`hardCodes`/`normalCodes`), else from the max HPs seen of this boss
    // (two clearly apart: the higher is Hard). null: not known yet.
    function difficulty() {
      if (!boss || !boss.key) return null;
      const b = bosses[boss.key];
      const code = spawnCode.get(boss.id);
      if (code && (b.hardCodes || []).includes(code)) return "hard";
      if (code && (b.normalCodes || []).includes(code)) return "normal";
      const max = boss.max;
      if (!(max > 0)) return null;
      if (b.hardMinHp && max >= b.hardMinHp) return "hard";
      if (b.hardMinHp) return "normal";
      if (boss.maxFromPeak) return null; // a peak seen mid-fight is no size to go by
      noteSize(boss.key, max);
      const seen = (prefs.sizes[boss.key] || []).slice().sort((x, y) => x - y);
      const lo = seen[0], hi = seen[seen.length - 1];
      if (hi < lo * 1.15) return null; // one size seen so far
      return max >= Math.sqrt(lo * hi) ? "hard" : "normal";
    }

    // Every max HP of a boss seen (the game's own, or the peak): kept, to tell Normal from Hard.
    function noteSize(key, max) {
      if (!key || !(max > 0)) return;
      const list = prefs.sizes[key] || [];
      if (list.some((m) => Math.abs(m - max) / max <= 0.02)) return;
      prefs.sizes = { ...prefs.sizes, [key]: list.concat(max).slice(-6) };
      hooks.savePrefs?.(prefs);
    }

    function newFight(id, key, hp) {
      const m = maxFor(id, key, hp);
      boss = { id, key, anchored: spawnKey.has(id), max: m.max, maxFromPeak: m.fromPeak, cur: hp, pct: 100, low: 100, fired: new Set(), seen: {}, start: now(), hpAt: now(), pullAt: 0, samples: [] };
      if (hp > 0) update(hp, now(), true);
      emitState();
    }

    function emitState() {
      if (!boss) return hooks.state?.(null);
      const b = bosses[boss.key];
      const next = thresholds(boss.key).find((t) => !boss.fired.has(t.id));
      hooks.state?.({
        key: boss.key,
        diff: difficulty(),
        low: boss.max > 0 ? boss.low : 100,
        name: b ? b.name : targetName || "Chefe",
        short: b ? b.short : "CHEFE",
        pct: boss.max > 0 ? boss.pct : null,
        approx: boss.maxFromPeak,
        next: next ? { pct: next.pct, title: next.title } : null,
        marks: thresholds(boss.key).filter((t) => !boss.fired.has(t.id)).map((t) => t.pct),
        cur: boss.cur,
        pullAt: boss.pullAt || 0,
        upcoming: upcoming(),
        dps: Math.round(dps()),
        enrage: enrageSecs(boss.key),
      });
    }

    function update(hp, at, quiet) {
      if (!boss) return;
      if (boss.max === 0 && hp > 0 && (boss.key || spawnMax.has(boss.id))) {
        const m = maxFor(boss.id, boss.key, hp);
        boss.max = m.max;
        boss.maxFromPeak = m.fromPeak;
      }
      if (hp > boss.max) {
        boss.max = hp;
        boss.maxFromPeak = true;
        if (boss.savedMax && boss.key) rememberMax(boss.key, hp); // a higher peak than the one saved
      }
      boss.cur = hp;
      boss.hpAt = now();
      boss.pct = boss.max > 0 ? (hp / boss.max) * 100 : 100;
      // A wipe or a reset: back near full after being well down.
      if (boss.low < 90 && boss.pct >= RESET_PCT) {
        boss.fired = new Set();
        boss.seen = {};
        boss.low = 100;
        boss.start = now();
        boss.pullAt = 0;
        boss.samples = [];
      }
      // The pull: the first HP under full. Opened mid-fight: from now.
      if (!boss.pullAt && hp > 0 && boss.max > 0 && boss.pct < 99.95) boss.pullAt = now();
      if (boss.pullAt) {
        const t = now();
        boss.samples.push([t, hp]);
        while (boss.samples.length > 2 && t - boss.samples[0][0] > DPS_WINDOW_MS) boss.samples.shift();
      }
      boss.low = Math.min(boss.low, boss.pct);
      if (!quiet && prefs.hpCalls && now() - at <= STALE_MS) checkThresholds();
      if (hp <= 0 && boss.maxFromPeak && boss.max > 0) rememberMax(boss.key, boss.max);
      if (boss.key && boss.maxFromPeak && boss.low < 50 && !boss.savedMax) {
        // Half way down with no saved max: the peak is as good as it gets, keep it.
        boss.savedMax = true;
        rememberMax(boss.key, boss.max);
      }
    }

    function checkThresholds() {
      const pre = Math.max(0, Number(prefs.prewarn) || 0);
      for (const t of thresholds(boss.key)) {
        if (boss.fired.has(t.id)) continue;
        if (boss.pct <= t.pct) {
          boss.fired.add(t.id);
          boss.fired.add(`pre:${t.id}`);
          // Several at once (a meter opened mid-fight): only the lowest is called.
          const lower = thresholds(boss.key).some((u) => u.pct < t.pct && boss.pct <= u.pct && !boss.fired.has(u.id));
          if (!lower) hooks.call({ kind: "hp", text: `${fmt(t.pct)}% — ${t.title}`, sub: t.sub, say: `${t.title}. ${t.sub}` });
        } else if (pre > 0 && boss.pct <= t.pct + pre && !boss.fired.has(`pre:${t.id}`)) {
          boss.fired.add(`pre:${t.id}`);
          hooks.call({ kind: "pre", text: `Em breve: ${t.title} (${fmt(t.pct)}%)`, sub: t.sub, say: `Prepara: ${t.title}` });
        }
      }
    }

    function fmt(n) {
      return Number(n).toFixed(Number.isInteger(Number(n)) ? 0 : 1).replace(".", ",");
    }

    // ---- the records -----------------------------------------------------

    function hp(d, at) {
      // `02 01 00 <u32 hp> 00 00 00 00` only: one entry, the HP. Anything else
      // (the player's own 01 01 01, FP or MP, two entries, a non-zero high
      // word that is no HP) is dropped at once.
      if (!d || Number(d.kind) !== 2 || Number(d.count) !== 1 || Number(d.res) !== 0) return;
      const id = Number(d.entity);
      const value = Number(d.hp);
      if (!Number.isFinite(id) || !Number.isFinite(value) || value < 0 || value > 0xffffffff) return;
      const t = now();
      for (const [k, v] of npc) if (t - v.at > KEEP_MS) npc.delete(k);
      if (boss && boss.id === id) return void (update(value, at), emitState());
      // A boss known by its spawn (a dungeon's, far under a raid's HP): its fight.
      const coded = spawnKey.get(id);
      if (coded) {
        if (holding() && boss.max > 0 && boss.pct < 99) return; // another boss's HP while ours is being fought
        if (!boss || boss.id !== id) newFight(id, coded, value);
        return;
      }
      if (holding()) return; // an add or a copy: the fight stays with the boss
      // Players and small monsters: dropped, never kept.
      if (value < data.minBossHp) return;
      npc.set(id, { hp: value, at: t });
      // No boss known yet (or the last one dead): the biggest monster about becomes "Chefe" until a skill names it.
      if (!boss || boss.cur <= 0 && boss.max > 0) newFight(id, null, value);
      else if (boss.key == null && value > boss.cur * 1.5) newFight(id, null, value);
      // Named by a skill whose caster sent no HP (an effect the boss put down):
      // the first monster of a boss's size is taken for it, the fight kept.
      else if (boss.key != null && boss.max === 0) {
        boss.id = id;
        update(value, at, true);
        emitState();
      }
    }

    // The "Chefe" is this boss: keep the fight, pick its saved max.
    function name(key, at) {
      boss.key = key;
      if (spawnMax.has(boss.id)) return; // the game's own max: nothing to pick
      const m = boss.cur > 0 ? pickMax(key, boss.cur) : { fromPeak: true };
      if (!m.fromPeak) {
        boss.max = m.max;
        boss.maxFromPeak = false;
        update(boss.cur, at, true);
      }
    }

    // The boss being fought is "anchored" when the game told us which boss it
    // is (its model code, from the spawn or the meter's target). Then nothing
    // takes the fight from it while it is alive and being hit: not a copy of
    // the boss (Ludra has some), not an add, not the other PT's boss.
    const holding = () => boss && boss.anchored && boss.cur > 0 && now() - boss.hpAt < GONE_MS;

    function identify(id, key, at) {
      if (boss && boss.id === id) {
        if (boss.key !== key && !boss.anchored) name(key, at);
        return boss.key === key;
      }
      if (holding()) {
        if (key === boss.key) return true; // the boss's own mechanic, cast by an effect or a copy
        if (spawnKey.get(id) !== key) return false; // another boss's skill from something that is no boss here
        if (boss.max > 0 && boss.pct < 99) return false; // our boss is being fought: stay
      }
      const last = npc.get(id); // kept only for monsters of a boss's size
      if (boss && !last) {
        // A caster with no HP of a boss's size: an effect or object the boss
        // put down (circles, orbs). The fight stays with the boss.
        if (boss.key === key) return;
        if (boss.key == null && boss.max > 0) return name(key, at);
      }
      // The same boss's skill from a big add, while the boss is still being
      // hit and is bigger: keep the boss.
      if (boss && last && boss.key === key && boss.cur > 0 && now() - boss.hpAt < LOST_MS && last.hp <= boss.max) return true;
      newFight(id, key, last ? last.hp : 0);
      return true;
    }

    function logIt(what, at) {
      const entry = { at, boss: boss?.key || null, what, pct: boss && boss.max > 0 ? Math.round(boss.pct * 10) / 10 : null, diff: difficulty(), code: boss ? spawnCode.get(boss.id) || null : null, since: boss && boss.pullAt ? at - boss.pullAt : null };
      log.push(entry);
      if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
      hooks.saveLog?.(log);
      return entry;
    }

    // ---- the boss cast bar ------------------------------------------------
    // What the boss is casting now, each with its countdown. The time is
    // data.js's `secs` when it has one, else the packet's own cast time, else a
    // short default; the bar ends early when the skill goes off (its 02 38).
    // Unknown skills come too (known: false): the page decides whether to show them.
    function castBars(t = now()) {
      return bars.filter((b) => b.end > t);
    }
    function emitBars() {
      hooks.bars?.(castBars());
    }
    function barStart(d, at, c, skill) {
      const t = now();
      if (t - at > STALE_MS) return; // queued while the window was shut: long over
      const ms = c && c.secs ? c.secs * 1000 : Number(d.ms) > 0 ? Number(d.ms) : BAR_DEFAULT_MS;
      const caster = Number(d.caster);
      const target = Number(d.target) || 0;
      const bar = {
        id: `${caster}:${skill}:${at}`,
        caster,
        skill,
        title: c ? c.title.replace(/!+$/, "") : String(d.skill_name || "").trim() || `Habilidade ${skill}`,
        sub: c ? c.sub : "",
        known: !!c,
        start: at,
        end: at + ms,
        target: target && target !== caster ? String(d.target_name || "").trim() : "",
        targetMe: !!(target && target !== caster && d.target_me),
        // A monster or NPC (a summon): "Esconder nomes" leaves it as it is.
        targetNpc: !!(target && target !== caster && d.target_npc),
      };
      // The same skill cast again (the packet repeats): its bar starts over.
      // Every live bar is kept (BAR_KEEP is only a safety cap): pickBars cuts
      // to the player's 1 to 3 rows after it drops the unknown skills, so a
      // burst of skills with no call can never push a real mechanic off.
      bars = [bar, ...castBars(t).filter((b) => !(b.caster === caster && b.skill === skill))].slice(0, BAR_KEEP);
      emitBars();
    }
    function barEnd(d, at) {
      const skill = Number(d && d.skill), caster = Number(d && d.caster);
      const before = bars.length;
      bars = bars.filter((b) => !(b.skill === skill && b.caster === caster && at - b.start >= BAR_END_AFTER_MS));
      if (bars.length !== before) emitBars();
    }
    function clearBars() {
      if (!bars.length) return;
      bars = [];
      emitBars();
    }

    // how: "cast" (09 38, a cast bar starts) or "use" (02 38, it goes off).
    function cast(d, at, how) {
      const skill = Number(d && d.skill);
      const key = bossOfSkill(skill);
      if (!key) return; // not one of ours: dropped
      const id = Number(d.caster);
      if (how === "use") barEnd(d, at);
      if (identify(id, key, at) === false) return; // not the boss we are fighting
      if (!boss || boss.key !== key) return;
      const c = bosses[key].casts.find((x) => x.skill === skill);
      if (how === "cast") barStart(d, at, c, skill);
      if (!c) {
        // A skill with no call yet: logged each time it comes (once for its
        // cast and its hit), so a raid's log shows which id is which mechanic
        // and how the rotation repeats.
        const u = `u:${skill}`;
        if (at - (boss.seen[u] || -1e9) >= 4000) {
          const n = (boss.seen[`un:${skill}`] || 0) + 1;
          boss.seen[`un:${skill}`] = n;
          logIt({ skill, n, title: `skill ${skill}` }, at);
        }
        boss.seen[u] = at;
        return emitState();
      }
      // The same skill comes as a cast (09 38) and when it goes off (02 38): once only.
      // Its 02 38 comes when the cast bar ends, which can be 15 s on.
      const k = `cast:${skill}`;
      const last = boss.seen[`t:${skill}`] || 0;
      const bar = boss.seen[`w:${skill}`] || 0;
      if (at - last < (c.gap || 4000) || (how === "use" && at <= bar)) return;
      boss.seen[`t:${skill}`] = at;
      if (how !== "use") boss.seen[`w:${skill}`] = at + Math.max(USE_AFTER_CAST_MS, (c.secs || 0) * 1000 + 4000);
      boss.seen[skill] = (boss.seen[skill] || 0) + 1;
      // The mechanic came (Bingo 1 can come at 58%, not 50%): its HP call is
      // done, so it is not called again later and "próximo" moves on.
      for (const t of thresholds(key)) {
        if (t.learn && t.learn.skill === skill && t.learn.nth === boss.seen[skill]) {
          boss.fired.add(t.id);
          boss.fired.add(`pre:${t.id}`);
        }
      }
      // A mechanic in fixed steps (Zikel's four rays): which step this is,
      // counted from the skill that starts it, or from a long pause.
      for (const x of bosses[key].casts) if (x.resetBy === skill) boss.seen[`step:${x.skill}`] = 0;
      let text = c.title, sub = c.sub;
      if (c.steps && c.steps.length) {
        const sk = `step:${skill}`, lastStep = boss.seen[`stepAt:${skill}`] || 0;
        if (at - lastStep > 20000) boss.seen[sk] = 0;
        const i = (boss.seen[sk] || 0) % c.steps.length;
        boss.seen[sk] = i + 1;
        boss.seen[`stepAt:${skill}`] = at;
        text = `${c.title} ${i + 1}/${c.steps.length}`;
        sub = c.steps[i];
      }
      logIt({ skill, n: boss.seen[skill], title: text }, at);
      if (prefs.castCalls && !prefs.off[`${key}:${k}`] && now() - at <= STALE_MS) {
        hooks.call({ kind: "cast", text, sub, say: `${text.replace(/ (\d)\/\d$/, " $1")}. ${sub}`, end: c.secs ? at + c.secs * 1000 : 0 });
      }
      emitState();
    }

    // You: the player's own entity (from the meter), for the effects the boss puts on you.
    let meId = 0;
    function setMe(id) {
      meId = Number(id) || 0;
    }
    // A Ludra boss's effect on you: called when data.js knows it (`onMe`),
    // else logged once a fight, so the logs show which effect is which mechanic.
    function onMe(abnormal, at) {
      if (!boss || !boss.key) return;
      const b = bosses[boss.key];
      if (!inRanges(abnormal, b.skills) && !(b.buffs || []).includes(abnormal)) return;
      const k = `me:${abnormal}`;
      const last = boss.seen[k] || 0;
      if (at - last < 4000) return;
      boss.seen[k] = at;
      const c = (b.onMe || []).find((x) => x.abnormal === abnormal);
      if (!c) {
        if (!boss.seen[`u${k}`]) {
          boss.seen[`u${k}`] = 1;
          logIt({ abnormal, title: `efeito ${abnormal} em você` }, at);
        }
        return;
      }
      logIt({ abnormal, title: `${c.title} (você)` }, at);
      if (prefs.castCalls && !prefs.off[`${boss.key}:me:${abnormal}`] && now() - at <= STALE_MS) {
        hooks.call({ kind: "me", text: c.title, sub: c.sub, say: `${c.title}. ${c.sub}` });
      }
    }

    function buff(d, at) {
      const abnormal = Number(d && d.abnormal);
      if (meId && Number(d && d.entity) === meId) return onMe(abnormal, at);
      const key = bossOfBuff(abnormal);
      if (!key) return;
      // Only on the boss being fought: the same id on anyone else is dropped.
      const entity = Number(d.entity);
      if (!boss || boss.id !== entity) return;
      if (boss.key == null) name(key, at);
      else if (boss.key !== key) return;
      const c = (bosses[key].buffCalls || []).find((x) => x.abnormal === abnormal);
      if (!c) return;
      const last = boss.seen[`b:${abnormal}`] || 0;
      if (at - last < 4000) return;
      boss.seen[`b:${abnormal}`] = at;
      logIt({ abnormal, title: c.title }, at);
      if (prefs.castCalls && !prefs.off[`${key}:buff:${abnormal}`] && now() - at <= STALE_MS) {
        hooks.call({ kind: "cast", text: c.title, sub: c.sub, say: `${c.title}. ${c.sub}` });
      }
    }

    // "Ajustar pelo registro": each HP mechanic that has a skill to learn from
    // gets the HP at which that skill really came (its last fights' average).
    function learnThresholds() {
      const out = {};
      for (const [key, b] of Object.entries(bosses)) {
        for (const t of b.hp) {
          if (!t.learn) continue;
          const seen = log.filter((e) => e.boss === key && e.what && e.what.skill === t.learn.skill && e.what.n === t.learn.nth && Number.isFinite(e.pct)).slice(-5);
          if (!seen.length) continue;
          const avg = seen.reduce((s, e) => s + e.pct, 0) / seen.length;
          // The call comes a hair before the skill: round up to the next half percent.
          const pct = Math.min(99, Math.ceil(avg * 2) / 2);
          out[key] = { ...(out[key] || {}), [t.id]: pct };
        }
      }
      return out;
    }

    // A monster spawning (41 36) with its max HP: only boss-sized ones come.
    function spawn(d) {
      const id = Number(d && d.entity);
      const max = Number(d && d.max);
      const key = bossOfCode(Number(d && d.code));
      if (!Number.isFinite(id) || !(max >= data.minBossHp || key)) return;
      spawnMax.set(id, max);
      const code = Number(d && d.code);
      if (code) {
        spawnCode.set(id, code);
        if (spawnCode.size > 200) spawnCode.delete(spawnCode.keys().next().value);
      }
      if (key) {
        spawnKey.set(id, key);
        if (spawnKey.size > 200) spawnKey.delete(spawnKey.keys().next().value);
      }
      if (spawnMax.size > 200) spawnMax.delete(spawnMax.keys().next().value);
      if (boss && boss.id === id && boss.maxFromPeak) {
        boss.max = max;
        boss.maxFromPeak = false;
        update(boss.cur, now(), true);
        emitState();
      }
    }

    // The group's damage per second, from the boss's HP going down.
    function dps() {
      const s = boss && boss.samples;
      if (!s || s.length < 2) return 0;
      const [t0, h0] = s[0], [t1, h1] = s[s.length - 1];
      return t1 - t0 >= 3000 ? Math.max(0, (h0 - h1) / ((t1 - t0) / 1000)) : 0;
    }
    function enrageSecs(key) {
      const v = (prefs.enrage || {})[key];
      if (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v))) return Number(v);
      return (key && bosses[key] && bosses[key].enrage) || 0;
    }

    // ---- the next mechanic by time -----------------------------------------
    // From the log of past fights: how long after the pull each skill first
    // comes, and how long between two of the same. The median of the last
    // ones; data.js can give its own (`first`, `every`, in seconds).
    const GAP_MIN_MS = 8000, GAP_MAX_MS = 240000, MIN_SAMPLES = 2;
    let timesCache = { n: -1, key: null, v: {} };
    function median(a) {
      const v = a.slice(-8).sort((x, y) => x - y);
      return v.length ? v[Math.floor(v.length / 2)] : 0;
    }
    function timesOf(key) {
      if (timesCache.n === log.length && timesCache.key === key) return timesCache.v;
      const out = {};
      const last = {};
      for (const e of log) {
        if (e.boss !== key || !e.what || !e.what.skill || e.what.title?.startsWith("skill ")) continue;
        const k = e.what.skill;
        const o = (out[k] = out[k] || { first: [], gaps: [] });
        if (e.what.n === 1 && e.since > 0 && e.since < 900000) o.first.push(e.since);
        const p = last[k];
        if (p && e.what.n === p.what.n + 1 && e.at - p.at >= GAP_MIN_MS && e.at - p.at <= GAP_MAX_MS) o.gaps.push(e.at - p.at);
        last[k] = e;
      }
      const v = {};
      for (const c of (bosses[key] && bosses[key].casts) || []) {
        const o = out[c.skill] || { first: [], gaps: [] };
        const first = o.first.length >= MIN_SAMPLES ? median(o.first) : c.first ? c.first * 1000 : 0;
        const every = o.gaps.length >= MIN_SAMPLES ? median(o.gaps) : c.every ? c.every * 1000 : 0;
        const sure = o.gaps.length >= 3 || o.first.length >= 3 || !!(c.first || c.every);
        if (first || every) v[c.skill] = { first, every, sure };
      }
      timesCache = { n: log.length, key, v };
      return v;
    }
    // The soonest mechanic due by time: { title, at, sure }.
    function upcoming() {
      if (!boss || !boss.key || !boss.pullAt || boss.cur <= 0) return null;
      const t = now();
      const times = timesOf(boss.key);
      let best = null;
      for (const c of bosses[boss.key].casts) {
        const m = times[c.skill];
        if (!m || prefs.off[`${boss.key}:cast:${c.skill}`]) continue;
        const lastAt = boss.seen[`t:${c.skill}`];
        const due = lastAt ? (m.every ? lastAt + m.every : 0) : m.first ? boss.pullAt + m.first : 0;
        if (!due || due < t - 3000) continue; // late by more than 3 s: not known when
        if (!best || due < best.at) best = { title: c.title, at: due, sure: m.sure, skill: c.skill };
      }
      return best;
    }

    // Once a second: the enrage warnings, and the timers refreshed.
    // The meter's target (A2Tools: the boss the group is hitting, with its name
    // and HP from the game). It decides which boss this is: a new boss target
    // starts its fight at once, named by its model code when data.js knows it.
    let targetName = "";
    function follow(t) {
      const id = Number(t && t.id) || 0;
      if (!id || !t.boss) return;
      const code = Number(t.code) || 0;
      if (code) spawnCode.set(id, code);
      const key = code ? bossOfCode(code) : null;
      if (key) spawnKey.set(id, key);
      if (t.max > 0 && !spawnMax.has(id)) spawnMax.set(id, t.max);
      targetName = t.name || "";
      if (boss && boss.id === id) {
        if (key && boss.key !== key) name(key, now());
        if (!boss.key) emitState();
        return;
      }
      if (!key && holding()) return;
      newFight(id, key, t.hp > 0 ? t.hp : 0);
    }

    function tick() {
      // No HP from the boss for a while (dead, reset, or we left): no boss.
      if (boss && now() - boss.hpAt > GONE_MS) {
        boss = null;
        clearBars();
        emitState();
        return;
      }
      // Bars run out on their own: told once they are all gone.
      if (bars.length && !castBars().length) clearBars();
      const up = upcoming();
      if (up && up.sure && prefs.castCalls && Number(prefs.prewarn) > 0) {
        const k = `soon:${up.skill}:${up.at}`;
        const left = (up.at - now()) / 1000;
        if (left <= 5 && left > 0 && !boss.fired.has(k)) {
          boss.fired.add(k);
          hooks.call({ kind: "pre", text: `Em breve: ${up.title}`, sub: "", say: `Prepara: ${up.title.replace(/!/g, "")}` });
        }
      }
      if (!boss || !boss.pullAt || boss.cur <= 0) return;
      const secs = enrageSecs(boss.key);
      if (!(secs > 0)) return;
      const left = secs - (now() - boss.pullAt) / 1000;
      if (left <= 60 && left > 0 && !boss.fired.has("enrage:60") && secs > 90) {
        boss.fired.add("enrage:60");
        if (!prefs.off[`${boss.key}:enrage`]) hooks.call({ kind: "pre", text: "ENRAGE EM 1 MINUTO", sub: "Guardem os buffs e batam tudo.", say: "Enrage em um minuto" });
      }
      if (left <= 0 && !boss.fired.has("enrage:0")) {
        boss.fired.add("enrage:0");
        if (!prefs.off[`${boss.key}:enrage`]) hooks.call({ kind: "cast", text: "ENRAGE!", sub: "O boss ficou mais forte.", say: "Enrage" });
      }
    }

    function clear() {
      boss = null;
      npc.clear();
      clearBars();
      emitState();
    }

    return { hp, spawn, cast, buff, tick, setMe, follow, enrageSecs, setPrefs, getLog, setLog, learnThresholds, thresholds, clear, castBars, _boss: () => boss };
  }

  // The boss cast bar's rows the player wants: data.js's mechanics always, the
  // skills with no call only when "show unknown skills" is on; at most `max`
  // (1 to 3), the newest first as the engine keeps them.
  function pickBars(bars, o = {}) {
    const max = Math.max(1, Math.min(BAR_MAX, Number(o.max) || 2));
    return (Array.isArray(bars) ? bars : []).filter((b) => b && (b.known || o.unknown)).slice(0, max);
  }

  // The calls on screen after a new one: a death card stays, the new call
  // goes first and only 2 calls fit (1 beside a death card). A "low" call
  // (a key's "GRAVANDO", "OVERLAYS DE VOLTA") never pushes a mechanic call
  // off the screen: it waits at the end, and is left out when there is no
  // room.
  function stackCalls(shown, c, at, until) {
    const dead = shown.filter((x) => x.kind === "dead" && x.until > at);
    const rest = shown.filter((x) => x.kind !== "dead" && x.until > at && x.text !== c.text);
    const room = dead.length ? 1 : 2;
    const item = { kind: c.kind, text: c.text, sub: c.sub, end: c.end || 0, until, ...(c.low ? { low: true } : {}) };
    if (c.low) {
      const calls = rest.filter((x) => !x.low);
      // Another key's notice is replaced; a mechanic call is not.
      const list = calls.length < room ? [...calls, item] : calls;
      return [...dead, ...list.slice(0, room)];
    }
    return [...dead, ...[item, ...rest].slice(0, room)];
  }

  // How long a call stays on the big text ("Tempo do aviso na tela"). A call
  // with a countdown stays until it is over, plus a moment; the others for a
  // few seconds, shorter for a heads-up ("pre"). hold: "short" | "normal" | "long".
  const HOLD = { short: [3000, 5000], normal: [5000, 8000], long: [8000, 12000] };
  function callUntil(c, at, hold) {
    if (c.end) return Math.max(c.end, at) + 1500;
    const [pre, other] = HOLD[hold] || HOLD.normal;
    return at + (c.kind === "pre" ? pre : other);
  }

  root.LudraEngine = { createEngine, pickBars, stackCalls, callUntil };
})(typeof window !== "undefined" ? window : globalThis);
