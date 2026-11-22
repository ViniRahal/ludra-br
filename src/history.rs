//! "Histórico das lutas": every boss fight, saved on the PC when it ends,
//! and your best DPS per boss and character.
//!
//! The `Recorder` watches the meter (about once a second) and hands back a
//! `Fight` when one ends: the boss dies, another boss is pulled, or no damage
//! moves for `IDLE_MS`. The `Store` keeps them as JSON files in a folder
//! (`historico/` in the app's data folder), the last `MAX_FIGHTS`, with an
//! index for the list and the records kept apart, so pruning never loses one.
//! The idea follows A2Tools' fight history and personal bests (GPL-3.0).
//!
//! "Linha do tempo" (the replay in the Histórico): each fight also keeps the
//! boss's HP about once a second, the deaths (with the blow that killed, when
//! the meter saw it), the revives and the stagger breaks. The mechanics are
//! called by the page (ui/logic.js), so the page adds them after the save
//! (`Store::add_marks`). The idea follows Aion2Flow's timeline playback and
//! aletheia's skill map.

use crate::meter::SkillRow;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Fights kept; the oldest go first.
pub const MAX_FIGHTS: usize = 300;
/// No damage on the boss for this long: the fight is over (wipe or reset).
pub const IDLE_MS: i64 = 30_000;
/// A timeline point every this many ms.
pub const POINT_MS: i64 = 5_000;
/// The boss's HP for the replay about this often (the meter looks 4 times a
/// second; a little under 1 s so the points do not drift to 1.25 s).
pub const HP_MS: i64 = 950;
/// At most this many HP points per fight (an hour): a fight left running
/// cannot grow a file without end.
pub const MAX_HP_POINTS: usize = 3_600;
/// At most this many deaths, revives and marks per fight.
pub const MAX_MARKS: usize = 400;
/// "Quantas lutas guardar": the range the page may set.
pub const MIN_KEEP: usize = 10;
pub const MAX_KEEP: usize = 2_000;
/// Shorter fights (a tag, a pull that never started) are not kept.
pub const MIN_FIGHT_MS: i64 = 10_000;
/// The Ludra raid's bosses (ui/data.js): Reator, Rahu, Ketu, Ludra, Normal and
/// Hard. A fight on one of them is "anchored": while it runs, the meter's
/// target moving to anything else (Ludra's copies 2921505/6, adds) keeps it.
pub const RAID_CODES: [i32; 8] = [2301008, 2300284, 2301006, 2300282, 2301007, 2300283, 2301014, 2300290];

pub fn is_raid(code: i32) -> bool {
    RAID_CODES.contains(&code)
}

/// A record needs at least this long a fight (a few seconds' burst is no record).
pub const MIN_BEST_MS: i64 = 30_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FightPlayer {
    pub name: String,
    pub class: String,
    pub me: bool,
    pub dps: f64,
    pub total: f64,
    pub deaths: i32,
    pub cp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Point {
    /// Fight time.
    pub t_ms: i64,
    pub boss_pct: Option<f64>,
    /// (name, DPS over the last 5 s).
    pub dps: Vec<(String, f64)>,
}

/// "Linha do tempo": a player's death, `t_ms` into the fight.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Death {
    pub t_ms: i64,
    pub name: String,
    #[serde(default)]
    pub class: String,
    #[serde(default)]
    pub me: bool,
    /// Who dealt the killing blow ("" not known).
    #[serde(default)]
    pub killer: String,
    /// The killing blow's skill ("" not known).
    #[serde(default)]
    pub skill: String,
    #[serde(default)]
    pub damage: i64,
}

/// "Linha do tempo": a moment worth a marker. `kind`: "mech" (a mechanic the
/// page called), "bingo", "stagger" (the gauge broke) or "revive".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Mark {
    pub t_ms: i64,
    pub kind: String,
    #[serde(default)]
    pub title: String,
    /// The boss's HP % then, when known.
    #[serde(default)]
    pub pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Fight {
    /// When it started (ms since 1970).
    pub id: i64,
    pub boss: String,
    pub code: i32,
    pub won: bool,
    pub duration_ms: i64,
    pub low_pct: f64,
    pub me: String,
    pub players: Vec<FightPlayer>,
    pub timeline: Vec<Point>,
    pub skills_me: Vec<SkillRow>,
    /// "Linha do tempo": [t_ms, boss HP %] about once a second. Fights saved
    /// before it existed (or with it off) have none: the page says so.
    #[serde(default)]
    pub hp: Vec<(i64, f64)>,
    #[serde(default)]
    pub deaths: Vec<Death>,
    /// Stagger breaks and revives from the meter, mechanics from the page.
    #[serde(default)]
    pub marks: Vec<Mark>,
}

impl Fight {
    pub fn my_dps(&self) -> f64 {
        self.players.iter().find(|p| p.me).map(|p| p.dps).unwrap_or(0.0)
    }

    /// "Salvar a linha do tempo" off: the fight as before it existed.
    pub fn drop_replay(&mut self) {
        self.hp.clear();
        self.deaths.clear();
        self.marks.clear();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FightSummary {
    pub id: i64,
    pub boss: String,
    pub code: i32,
    pub won: bool,
    pub duration_ms: i64,
    pub low_pct: f64,
    pub my_dps: f64,
    /// This fight is your current record for its boss.
    pub best: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Best {
    pub boss: String,
    pub code: i32,
    pub character: String,
    pub dps: f64,
    /// The fight it was set in.
    pub id: i64,
    pub at_ms: i64,
}

/// A record just beaten (the `new-best` event).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NewBest {
    pub boss: String,
    pub dps: f64,
    pub previous: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
struct IndexEntry {
    id: i64,
    boss: String,
    code: i32,
    won: bool,
    duration_ms: i64,
    low_pct: f64,
    my_dps: f64,
    me: String,
}

// ---- Recording -------------------------------------------------------------

/// What the recorder needs from one look at the meter.
#[derive(Debug, Clone, Default)]
pub struct Sample {
    pub now_ms: i64,
    pub target_id: i32,
    pub boss: bool,
    pub name: String,
    pub code: i32,
    pub pct: Option<f64>,
    /// The meter's fight time.
    pub time_ms: i64,
    pub me: String,
    pub players: Vec<FightPlayer>,
    /// The anchored boss's HP %, when the target is something else (see `anchor`).
    pub anchor_pct: Option<f64>,
    /// The target's stagger gauge, 0-100 (None: no gauge seen).
    pub stagger: Option<f64>,
    /// The meter's recent deaths: (when, ms since 1970; who and what killed).
    /// The same ones come again on each look; the recorder keeps each once.
    pub deaths: Vec<(i64, Death)>,
    /// The party's frames now: who is down and who is up (for the revives).
    pub dead_now: Vec<String>,
    pub alive_now: Vec<String>,
}

#[derive(Debug, Clone)]
struct Live {
    fight: Fight,
    target_id: i32,
    last_total: f64,
    last_change_ms: i64,
    last_point_ms: i64,
    point_totals: HashMap<String, f64>,
    last_hp_ms: i64,
    last_stagger: Option<f64>,
    /// Down on the party frames (a revive is one of these up again).
    down: HashSet<String>,
    /// Deaths already kept: (name, when).
    seen_deaths: HashSet<(String, i64)>,
}

impl Live {
    /// The replay's part of one look: the boss's HP (`pct`, the anchored
    /// boss's while the target is a copy), the deaths, the revives, and, when
    /// the target is the fight's boss (`own`), its stagger breaks.
    fn track(&mut self, s: &Sample, pct: Option<f64>, own: bool) {
        let id = self.fight.id;
        let t = (s.now_ms - id).max(0);
        let f = &mut self.fight;
        if let Some(p) = pct {
            // The kill (0 %) is always kept: the fight ends on that same look,
            // and a won fight's line must reach the bottom.
            if (s.now_ms - self.last_hp_ms >= HP_MS || p <= 0.0) && f.hp.len() < MAX_HP_POINTS {
                f.hp.push((t, (p.clamp(0.0, 100.0) * 10.0).round() / 10.0));
                self.last_hp_ms = s.now_ms;
            }
        }
        let room = |f: &Fight| f.deaths.len() + f.marks.len() < MAX_MARKS;
        // The break: the same rule as the page's "QUEBROU" call (ui/plugin.js).
        if own {
            if let (Some(last), Some(st)) = (self.last_stagger, s.stagger) {
                if last >= 80.0 && st <= last - 50.0 && room(f) {
                    f.marks.push(Mark { t_ms: t, kind: "stagger".into(), title: "Stagger quebrado".into(), pct });
                }
            }
            self.last_stagger = s.stagger;
        }
        for (at, d) in &s.deaths {
            if *at < id - 1_000 || *at > s.now_ms + 1_000 || !room(f) || !self.seen_deaths.insert((d.name.clone(), *at)) {
                continue;
            }
            f.deaths.push(Death { t_ms: (at - id).max(0), ..d.clone() });
        }
        // A frame with no name yet is skipped: it would add empty revives.
        for n in s.alive_now.iter().filter(|n| !n.is_empty()) {
            if self.down.remove(n) && room(f) {
                f.marks.push(Mark { t_ms: t, kind: "revive".into(), title: n.clone(), pct });
            }
        }
        self.down.extend(s.dead_now.iter().filter(|n| !n.is_empty()).cloned());
    }
}

#[derive(Debug, Default)]
pub struct Recorder {
    live: Option<Live>,
    /// The boss whose fight just ended: not started again until the target changes.
    ended: Option<i32>,
    /// Fights started so far (the meter's `pull`, a fight boundary for the UI).
    pulls: u32,
}

impl Recorder {
    /// A timeline point is due on the next sample (so the caller fetches your skills).
    pub fn due(&self, now_ms: i64) -> bool {
        self.live.as_ref().map_or(true, |l| now_ms - l.last_point_ms >= POINT_MS)
    }

    /// Fights started so far: a new number means a new pull.
    pub fn pulls(&self) -> u32 {
        self.pulls
    }

    /// The raid boss a running fight is anchored to, for its HP while the
    /// meter looks at something else.
    pub fn anchor(&self) -> Option<i32> {
        self.live.as_ref().filter(|l| is_raid(l.fight.code)).map(|l| l.target_id)
    }

    /// One look at the meter. `skills_me`: your skills now, when `due` said so.
    /// Returns the fights that ended (usually none).
    pub fn feed(&mut self, s: &Sample, skills_me: Option<Vec<SkillRow>>) -> Vec<Fight> {
        let mut out = Vec::new();
        let active = s.boss && s.target_id != 0 && s.time_ms > 0 && s.players.iter().any(|p| p.total > 0.0);
        if self.ended.is_some() && self.ended != Some(s.target_id) && s.target_id != 0 {
            self.ended = None;
        }
        // Anchored: the target moved off the raid boss to something that is not
        // one (a copy, an add). Same fight: only the boss's HP is followed.
        if let Some(l) = self.live.as_mut() {
            if is_raid(l.fight.code) && s.target_id != l.target_id && s.target_id != 0 && !is_raid(s.code) {
                l.track(s, s.anchor_pct, false);
                if let Some(p) = s.anchor_pct {
                    if p < l.fight.low_pct {
                        l.fight.low_pct = p;
                        l.last_change_ms = s.now_ms;
                    }
                    if p <= 0.0 {
                        l.fight.won = true;
                    }
                }
                if s.now_ms - l.last_change_ms < IDLE_MS && !l.fight.won {
                    return out;
                }
                let ended = l.target_id;
                out.extend(self.finish());
                self.ended = Some(ended);
                return out;
            }
        }
        if let Some(l) = &self.live {
            let other_boss = active && s.target_id != l.target_id;
            let idle = s.now_ms - l.last_change_ms >= IDLE_MS;
            if other_boss || idle {
                let ended = l.target_id;
                out.extend(self.finish());
                if idle {
                    self.ended = Some(ended);
                }
            }
        }
        if !active || self.ended == Some(s.target_id) {
            return out;
        }
        let total: f64 = s.players.iter().map(|p| p.total).sum();
        if self.live.is_none() {
            self.pulls = self.pulls.wrapping_add(1);
        }
        let live = self.live.get_or_insert_with(|| Live {
            fight: Fight { id: s.now_ms - s.time_ms, boss: s.name.clone(), code: s.code, low_pct: 100.0, ..Default::default() },
            target_id: s.target_id,
            last_total: -1.0,
            last_change_ms: s.now_ms,
            last_point_ms: i64::MIN / 2,
            point_totals: HashMap::new(),
            last_hp_ms: i64::MIN / 2,
            last_stagger: None,
            down: HashSet::new(),
            seen_deaths: HashSet::new(),
        });
        live.track(s, s.pct, true);
        if total != live.last_total {
            live.last_total = total;
            live.last_change_ms = s.now_ms;
        }
        let f = &mut live.fight;
        if f.boss.is_empty() {
            f.boss = s.name.clone();
        }
        if f.code == 0 {
            f.code = s.code;
        }
        if !s.me.is_empty() {
            f.me = s.me.clone();
        }
        f.players = s.players.clone();
        f.duration_ms = f.duration_ms.max(s.time_ms);
        if let Some(p) = s.pct {
            f.low_pct = f.low_pct.min(p);
            if p <= 0.0 {
                f.won = true;
            }
        }
        if s.now_ms - live.last_point_ms >= POINT_MS {
            let secs = if live.point_totals.is_empty() { (s.time_ms as f64 / 1000.0).max(1.0) } else { ((s.now_ms - live.last_point_ms) as f64 / 1000.0).max(1.0) };
            let dps = s.players.iter().map(|p| (p.name.clone(), ((p.total - live.point_totals.get(&p.name).copied().unwrap_or(0.0)) / secs).max(0.0))).collect();
            f.timeline.push(Point { t_ms: s.time_ms, boss_pct: s.pct, dps });
            live.point_totals = s.players.iter().map(|p| (p.name.clone(), p.total)).collect();
            live.last_point_ms = s.now_ms;
            if let Some(sk) = skills_me {
                f.skills_me = sk;
            }
        }
        if live.fight.won {
            let ended = live.target_id;
            out.extend(self.finish());
            self.ended = Some(ended);
        }
        out
    }

    fn finish(&mut self) -> Option<Fight> {
        let l = self.live.take()?;
        let total: f64 = l.fight.players.iter().map(|p| p.total).sum();
        (l.fight.duration_ms >= MIN_FIGHT_MS && total > 0.0).then_some(l.fight)
    }
}

// ---- Storage ---------------------------------------------------------------

pub struct Store {
    dir: PathBuf,
    /// Fights kept ("Quantas lutas guardar").
    keep: usize,
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Store { dir: dir.into(), keep: MAX_FIGHTS }
    }

    /// Keeps the last `n` fights (`MIN_KEEP`..`MAX_KEEP`) from the next save on.
    pub fn keep(mut self, n: usize) -> Self {
        self.keep = n.clamp(MIN_KEEP, MAX_KEEP);
        self
    }

    fn fight_path(&self, id: i64) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn index(&self) -> Vec<IndexEntry> {
        std::fs::read(self.dir.join("indice.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn write_index(&self, idx: &[IndexEntry]) -> std::io::Result<()> {
        write_atomic(&self.dir.join("indice.json"), &serde_json::to_vec(idx).unwrap_or_default())
    }

    pub fn bests(&self) -> Vec<Best> {
        std::fs::read(self.dir.join("recordes.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// Saves the fight, drops the oldest past `keep` (`MAX_FIGHTS` unless set), and updates your
    /// record. Returns the record it beat, if it beat one.
    pub fn save(&self, f: &Fight) -> std::io::Result<Option<NewBest>> {
        std::fs::create_dir_all(&self.dir)?;
        write_atomic(&self.fight_path(f.id), &serde_json::to_vec(f).unwrap_or_default())?;
        let mut idx = self.index();
        idx.retain(|e| e.id != f.id);
        idx.push(IndexEntry { id: f.id, boss: f.boss.clone(), code: f.code, won: f.won, duration_ms: f.duration_ms, low_pct: f.low_pct, my_dps: f.my_dps(), me: f.me.clone() });
        idx.sort_by_key(|e| e.id);
        // The oldest go first, but a record's fight (🏆) stays, so the page's
        // "os recordes ficam" holds for the fight itself, not just its number.
        let best_ids: HashSet<i64> = self.bests().iter().map(|b| b.id).collect();
        while idx.len() > self.keep {
            let Some(i) = idx.iter().position(|e| !best_ids.contains(&e.id)) else { break };
            let old = idx.remove(i);
            let _ = std::fs::remove_file(self.fight_path(old.id));
        }
        self.write_index(&idx)?;
        let dps = f.my_dps();
        if dps <= 0.0 || f.duration_ms < MIN_BEST_MS || f.me.is_empty() {
            return Ok(None);
        }
        let mut bests = self.bests();
        let pos = bests.iter().position(|b| b.code == f.code && b.character == f.me);
        let previous = pos.map(|i| bests[i].dps);
        if previous.is_some_and(|p| p >= dps) {
            return Ok(None);
        }
        let best = Best { boss: f.boss.clone(), code: f.code, character: f.me.clone(), dps, id: f.id, at_ms: f.id + f.duration_ms };
        match pos {
            Some(i) => bests[i] = best,
            None => bests.push(best),
        }
        write_atomic(&self.dir.join("recordes.json"), &serde_json::to_vec(&bests).unwrap_or_default())?;
        Ok(previous.map(|previous| NewBest { boss: f.boss.clone(), dps, previous }))
    }

    /// Newest first.
    pub fn list(&self) -> Vec<FightSummary> {
        let bests = self.bests();
        let mut v: Vec<FightSummary> = self
            .index()
            .into_iter()
            .map(|e| FightSummary { best: bests.iter().any(|b| b.id == e.id), id: e.id, boss: e.boss, code: e.code, won: e.won, duration_ms: e.duration_ms, low_pct: e.low_pct, my_dps: e.my_dps })
            .collect();
        v.sort_by(|a, b| b.id.cmp(&a.id));
        v
    }

    pub fn get(&self, id: i64) -> Option<Fight> {
        std::fs::read(self.fight_path(id)).ok().and_then(|b| serde_json::from_slice(&b).ok())
    }

    /// "Linha do tempo": the mechanics the page called during fight `id`
    /// (the page's own marks of an earlier call are replaced; the meter's
    /// stagger breaks and revives stay). False: no such fight.
    pub fn add_marks(&self, id: i64, marks: Vec<Mark>) -> std::io::Result<bool> {
        let Some(mut f) = self.get(id) else { return Ok(false) };
        f.marks.retain(|m| m.kind != "mech" && m.kind != "bingo");
        let room = MAX_MARKS.saturating_sub(f.marks.len() + f.deaths.len());
        f.marks.extend(
            marks
                .into_iter()
                .filter(|m| m.kind == "mech" || m.kind == "bingo")
                .take(room)
                .map(|m| Mark { t_ms: m.t_ms.clamp(0, f.duration_ms + 10_000), title: m.title.chars().take(80).collect(), ..m }),
        );
        f.marks.sort_by_key(|m| m.t_ms);
        write_atomic(&self.fight_path(id), &serde_json::to_vec(&f).unwrap_or_default())?;
        Ok(true)
    }

    /// Removes the fight (a record set in it stays: it was your best).
    pub fn delete(&self, id: i64) -> std::io::Result<()> {
        let _ = std::fs::remove_file(self.fight_path(id));
        let mut idx = self.index();
        idx.retain(|e| e.id != id);
        self.write_index(&idx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player(name: &str, me: bool, total: f64, time_ms: i64) -> FightPlayer {
        FightPlayer { name: name.into(), class: "ranger".into(), me, dps: total / (time_ms as f64 / 1000.0), total, deaths: 0, cp: 0 }
    }

    fn sample(now: i64, target: i32, time_ms: i64, pct: f64, totals: (f64, f64)) -> Sample {
        Sample {
            now_ms: now,
            target_id: target,
            boss: true,
            name: "Ludra da Eternidade".into(),
            code: 2301014,
            pct: Some(pct),
            time_ms,
            me: "Eu".into(),
            players: vec![player("Eu", true, totals.0, time_ms.max(1)), player("Outro", false, totals.1, time_ms.max(1))],
            ..Default::default()
        }
    }

    #[test]
    fn copies_of_ludra_do_not_split_the_fight() {
        let mut r = Recorder::default();
        let ludra = |now: i64, t: i64, pct: f64, d: f64| Sample { code: 2301014, ..sample(now, 7, t, pct, (d, d / 2.0)) };
        for s in 1..=20 {
            assert!(r.feed(&ludra(s * 1000, s * 1000, 100.0 - s as f64, s as f64 * 1e4), None).is_empty());
        }
        assert_eq!(r.anchor(), Some(7));
        assert_eq!(r.pulls(), 1);
        // 40 s on a copy (boss-flagged, its own code, 100% HP): the Ludra's HP keeps falling.
        for s in 21..=60 {
            let copy = Sample { target_id: 99, code: 2921505, pct: Some(100.0), time_ms: (s - 20) * 1000, anchor_pct: Some(80.0 - (s - 20) as f64 * 0.2), ..sample(s * 1000, 99, 1000, 100.0, (5e3, 0.0)) };
            assert!(r.feed(&copy, None).is_empty(), "split at {s}");
        }
        assert_eq!(r.live.as_ref().unwrap().target_id, 7);
        // The target switch is the same pull ("Esconder nomes" keeps its numbers).
        assert_eq!(r.pulls(), 1);
        // Back on the Ludra, which dies: one fight, the copy's damage not in it.
        let out = r.feed(&ludra(61_000, 61_000, 0.0, 9e5), None);
        assert_eq!(out.len(), 1);
        let f = &out[0];
        assert!(f.won && f.code == 2301014 && f.id == 0);
        assert_eq!(f.players[0].total, 9e5);
        assert!(f.low_pct == 0.0);
    }

    #[test]
    fn the_replay_keeps_hp_each_second_deaths_revives_and_breaks() {
        let mut r = Recorder::default();
        let t0 = 1_000_000;
        let death = Death { name: "Outro".into(), killer: "Ludra".into(), skill: "Raio".into(), damage: 90_000, ..Default::default() };
        let mut out = Vec::new();
        // 4 looks a second for 30 s; the boss dies at the end.
        for q in 1..=120 {
            let now = t0 + q * 250;
            let pct = if q == 120 { 0.0 } else { 100.0 - q as f64 * 0.5 };
            let mut s = sample(now, 7, q * 250, pct, (q as f64 * 10_000.0, q as f64 * 4_000.0));
            // The gauge fills, then breaks at 10 s.
            s.stagger = Some(if q < 40 { q as f64 * 2.4 } else { 5.0 });
            // "Outro" dies at 12 s (the meter sends the recap on every look after), up again at 20 s.
            if q >= 48 {
                s.deaths = vec![(t0 + 12_000, death.clone())];
            }
            if (48..80).contains(&q) {
                s.dead_now = vec!["Outro".into()];
            } else {
                s.alive_now = vec!["Outro".into()];
            }
            out.extend(r.feed(&s, None));
        }
        assert_eq!(out.len(), 1);
        let f = &out[0];
        assert!(f.hp.len() >= 29 && f.hp.len() <= 32, "{}", f.hp.len());
        assert_eq!(f.hp[0], (250, 99.5));
        // Each second, except the kill, which is always the last point.
        let n = f.hp.len();
        assert!(f.hp[..n - 1].windows(2).all(|w| w[1].0 - w[0].0 >= HP_MS));
        assert_eq!(f.hp.last().unwrap(), &(30_000, 0.0));
        assert_eq!(f.deaths.len(), 1);
        assert_eq!((f.deaths[0].t_ms, f.deaths[0].skill.as_str()), (12_000, "Raio"));
        let kinds: Vec<_> = f.marks.iter().map(|m| (m.kind.as_str(), m.t_ms)).collect();
        assert_eq!(kinds, vec![("stagger", 10_000), ("revive", 20_000)]);
        // Off: none of it is saved.
        let mut g = f.clone();
        g.drop_replay();
        assert!(g.hp.is_empty() && g.deaths.is_empty() && g.marks.is_empty() && !g.timeline.is_empty());
    }

    #[test]
    fn old_fights_open_and_the_page_adds_its_mechanics() {
        // A fight saved before the replay: no hp, deaths nor marks in its file.
        let old: Fight = serde_json::from_str(r#"{"id":5,"boss":"Ludra","code":2301014,"won":true,"duration_ms":60000,"low_pct":0,"me":"Eu","players":[],"timeline":[],"skills_me":[]}"#).unwrap();
        assert!(old.hp.is_empty() && old.marks.is_empty());
        let dir = tmp("marks");
        let st = Store::new(&dir).keep(MIN_KEEP);
        let mut f = Fight { id: 9, duration_ms: 60_000, ..Default::default() };
        f.marks.push(Mark { t_ms: 30_000, kind: "stagger".into(), ..Default::default() });
        st.save(&f).unwrap();
        let mech = |t: i64, kind: &str| Mark { t_ms: t, kind: kind.into(), title: "Bingo! Achem o quadrado azul e fiquem nele por bastante tempo, todo mundo junto".into(), pct: Some(50.0) };
        assert!(st.add_marks(9, vec![mech(40_000, "bingo"), mech(10_000, "mech"), mech(1, "revive")]).unwrap());
        // Twice: replaced, not doubled.
        assert!(st.add_marks(9, vec![mech(40_000, "bingo"), mech(10_000, "mech")]).unwrap());
        let g = st.get(9).unwrap();
        assert_eq!(g.marks.iter().map(|m| (m.kind.as_str(), m.t_ms)).collect::<Vec<_>>(), vec![("mech", 10_000), ("stagger", 30_000), ("bingo", 40_000)]);
        assert!(g.marks[0].title.chars().count() <= 80);
        assert!(!st.add_marks(404, vec![]).unwrap());
        // "Quantas lutas guardar": the oldest go past the number set.
        for id in 100..(100 + MIN_KEEP as i64 + 5) {
            st.save(&Fight { id, ..Default::default() }).unwrap();
        }
        assert_eq!(st.list().len(), MIN_KEEP);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ludra-hist-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_fight_ends_when_the_boss_dies_and_has_a_timeline() {
        let mut r = Recorder::default();
        let t0 = 1_000_000;
        let mut ended = Vec::new();
        for s in 1..=60 {
            let pct = if s == 60 { 0.0 } else { 100.0 - s as f64 * 1.6 };
            ended.extend(r.feed(&sample(t0 + s * 1000, 7, s * 1000, pct, (s as f64 * 50_000.0, s as f64 * 20_000.0)), None));
        }
        assert_eq!(ended.len(), 1);
        let f = &ended[0];
        assert!(f.won);
        assert_eq!(f.id, t0);
        assert_eq!(f.duration_ms, 60_000);
        assert_eq!(f.low_pct, 0.0);
        assert!((f.my_dps() - 50_000.0).abs() < 1.0);
        assert!(f.timeline.len() >= 11 && f.timeline.len() <= 13);
        let p = &f.timeline[3];
        assert!((p.dps[0].1 - 50_000.0).abs() < 1.0, "{:?}", p);
        // The dead boss still targeted: no second fight.
        assert!(r.feed(&sample(t0 + 61_000, 7, 60_000, 0.0, (3e6, 1.2e6)), None).is_empty());
        assert!(r.live.is_none());
    }

    #[test]
    fn a_wipe_ends_after_no_damage_and_short_pulls_are_dropped() {
        let mut r = Recorder::default();
        for s in 1..=20 {
            assert!(r.feed(&sample(s * 1000, 7, s * 1000, 80.0, (s as f64 * 1000.0, 0.0)), None).is_empty());
        }
        // Damage stops: 30 s later it ends, not won.
        let mut out = Vec::new();
        for s in 21..=55 {
            out.extend(r.feed(&sample(s * 1000, 7, 20_000, 80.0, (20_000.0, 0.0)), None));
        }
        assert_eq!(out.len(), 1);
        assert!(!out[0].won);
        // A 5 s tag on another boss, then a third boss: dropped as too short.
        r.feed(&sample(100_000, 8, 1000, 99.0, (10.0, 0.0)), None);
        let out = r.feed(&sample(105_000, 9, 1000, 99.0, (10.0, 0.0)), None);
        assert!(out.is_empty());
    }

    #[test]
    fn the_store_keeps_the_last_fights_and_your_bests() {
        let dir = tmp("store");
        let st = Store::new(&dir);
        let fight = |id: i64, dps: f64| Fight {
            id,
            boss: "Ludra da Eternidade".into(),
            code: 2301014,
            duration_ms: 60_000,
            me: "Eu".into(),
            players: vec![FightPlayer { name: "Eu".into(), me: true, dps, total: dps * 60.0, ..Default::default() }],
            ..Default::default()
        };
        assert_eq!(st.save(&fight(1, 40_000.0)).unwrap(), None, "the first is a record, but nothing was beaten");
        assert_eq!(st.save(&fight(2, 30_000.0)).unwrap(), None);
        let nb = st.save(&fight(3, 55_000.0)).unwrap().unwrap();
        assert_eq!((nb.dps, nb.previous), (55_000.0, 40_000.0));
        let bests = st.bests();
        assert_eq!(bests.len(), 1);
        assert_eq!(bests[0].id, 3);
        let list = st.list();
        assert_eq!(list.iter().map(|f| f.id).collect::<Vec<_>>(), vec![3, 2, 1]);
        assert!(list[0].best && !list[1].best);
        assert_eq!(st.get(2).unwrap().my_dps(), 30_000.0);
        st.delete(2).unwrap();
        assert!(st.get(2).is_none());
        assert_eq!(st.list().len(), 2);
        // Pruning: past MAX_FIGHTS the oldest go; the record's fight stays.
        for id in 10..(10 + MAX_FIGHTS as i64) {
            st.save(&fight(id, 1000.0)).unwrap();
        }
        let list = st.list();
        assert_eq!(list.len(), MAX_FIGHTS);
        assert!(st.get(1).is_none() && st.get(10).is_none());
        assert!(st.get(3).is_some() && list.iter().any(|f| f.id == 3 && f.best));
        assert_eq!(st.bests()[0].id, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
