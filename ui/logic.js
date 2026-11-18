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
//    in data.js are looked at; everything else is dropped at once.
//  - boss-buff (2A 38): entity, abnormal. Same: only data.js's ids.
//
// A monster's HP is kept only for a few seconds (to know the boss's HP the
// moment it is recognised), and only the boss's after that.
(function (root) {
  const KEEP_MS = 20_000; // a monster's last HP, kept this long until it turns out to be the boss
  const STALE_MS = 3_000; // events older than this (queued while the window was shut) are not called
  const RESET_PCT = 98; // back above this after going under 90: a wipe, a new pull
  const MAX_LOG = 200;
  const LOST_MS = 15_000; // no HP from the boss this long: gone (a reset that respawned it)
  const USE_AFTER_CAST_MS = 10_000; // a 02 38 this long after the same skill's 09 38: the same cast going off

  function inRanges(id, ranges) {
    for (const [a, b] of ranges) if (id >= a && id <= b) return true;
    return false;
  }

  function createEngine(data, hooks) {
    const now = hooks.now || (() => Date.now());
    const bosses = data.bosses;
    let prefs = { prewarn: 3, hpCalls: true, castCalls: true, thresholds: {}, maxHp: {}, off: {}, enrage: {} };
    const DPS_WINDOW_MS = 20_000; // the group's damage per second: over this long

    const npc = new Map(); // entity -> { hp, at }, monsters only, a few seconds
    const spawnMax = new Map(); // entity -> max HP, from its spawn (the game's own number)
    let boss = null; // { id, key, max, maxFromPeak, cur, pct, low, fired:Set, seen:{skill:n}, start }
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
      return b.hp
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

    function newFight(id, key, hp) {
      const m = maxFor(id, key, hp);
      boss = { id, key, max: m.max, maxFromPeak: m.fromPeak, cur: hp, pct: 100, low: 100, fired: new Set(), seen: {}, start: now(), hpAt: now(), pullAt: 0, samples: [] };
      if (hp > 0) update(hp, now(), true);
      emitState();
    }

    function emitState() {
      if (!boss) return hooks.state?.(null);
      const b = bosses[boss.key];
      const next = thresholds(boss.key).find((t) => !boss.fired.has(t.id));
      hooks.state?.({
        key: boss.key,
        name: b ? b.name : "Chefe",
        short: b ? b.short : "CHEFE",
        pct: boss.max > 0 ? boss.pct : null,
        approx: boss.maxFromPeak,
        next: next ? { pct: next.pct, title: next.title } : null,
        marks: thresholds(boss.key).filter((t) => !boss.fired.has(t.id)).map((t) => t.pct),
        cur: boss.cur,
        pullAt: boss.pullAt || 0,
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

    function identify(id, key, at) {
      if (boss && boss.id === id) {
        if (boss.key !== key) name(key, at);
        return;
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
      if (boss && last && boss.key === key && boss.cur > 0 && now() - boss.hpAt < LOST_MS && last.hp <= boss.max) return;
      newFight(id, key, last ? last.hp : 0);
    }

    function logIt(what, at) {
      const entry = { at, boss: boss?.key || null, what, pct: boss && boss.max > 0 ? Math.round(boss.pct * 10) / 10 : null };
      log.push(entry);
      if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
      hooks.saveLog?.(log);
      return entry;
    }

    // how: "cast" (09 38, a cast bar starts) or "use" (02 38, it goes off).
    function cast(d, at, how) {
      const skill = Number(d && d.skill);
      const key = bossOfSkill(skill);
      if (!key) return; // not one of ours: dropped
      const id = Number(d.caster);
      identify(id, key, at);
      const c = bosses[key].casts.find((x) => x.skill === skill);
      if (!c) return emitState();
      // The same skill comes as a cast (09 38) and when it goes off (02 38): once only.
      // Its 02 38 comes when the cast bar ends, which can be 15 s on.
      const k = `cast:${skill}`;
      const last = boss.seen[`t:${skill}`] || 0;
      const bar = boss.seen[`w:${skill}`] || 0;
      if (at - last < 4000 || (how === "use" && at <= bar)) return;
      boss.seen[`t:${skill}`] = at;
      if (how !== "use") boss.seen[`w:${skill}`] = at + Math.max(USE_AFTER_CAST_MS, (c.secs || 0) * 1000 + 4000);
      boss.seen[skill] = (boss.seen[skill] || 0) + 1;
      logIt({ skill, n: boss.seen[skill], title: c.title }, at);
      if (prefs.castCalls && !prefs.off[`${key}:${k}`] && now() - at <= STALE_MS) {
        hooks.call({ kind: "cast", text: c.title, sub: c.sub, say: `${c.title}. ${c.sub}`, end: c.secs ? at + c.secs * 1000 : 0 });
      }
      emitState();
    }

    function buff(d, at) {
      const abnormal = Number(d && d.abnormal);
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
      if (!Number.isFinite(id) || !(max >= data.minBossHp)) return;
      spawnMax.set(id, max);
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

    // Once a second: the enrage warnings, and the timers refreshed.
    function tick() {
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
      emitState();
    }

    return { hp, spawn, cast, buff, tick, enrageSecs, setPrefs, getLog, setLog, learnThresholds, thresholds, clear, _boss: () => boss };
  }

  root.LudraEngine = { createEngine };
})(typeof window !== "undefined" ? window : globalThis);
