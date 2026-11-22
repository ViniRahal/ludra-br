//! "Histórico das lutas": every boss fight, saved on the PC when it ends,
//! and your best DPS per boss and character.
//!
//! The `Recorder` watches the meter (about once a second) and hands back a
//! `Fight` when one ends: the boss dies, another boss is pulled, or no damage
//! moves for `IDLE_MS`. The `Store` keeps them as JSON files in a folder
//! (`historico/` in the app's data folder), the last `MAX_FIGHTS`, with an
//! index for the list and the records kept apart, so pruning never loses one.
//! The idea follows A2Tools' fight history and personal bests (GPL-3.0).

use crate::meter::SkillRow;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Fights kept; the oldest go first.
pub const MAX_FIGHTS: usize = 300;
/// No damage on the boss for this long: the fight is over (wipe or reset).
pub const IDLE_MS: i64 = 30_000;
/// A timeline point every this many ms.
pub const POINT_MS: i64 = 5_000;
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
}

impl Fight {
    pub fn my_dps(&self) -> f64 {
        self.players.iter().find(|p| p.me).map(|p| p.dps).unwrap_or(0.0)
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
}

#[derive(Debug, Clone)]
struct Live {
    fight: Fight,
    target_id: i32,
    last_total: f64,
    last_change_ms: i64,
    last_point_ms: i64,
    point_totals: HashMap<String, f64>,
}

#[derive(Debug, Default)]
pub struct Recorder {
    live: Option<Live>,
    /// The boss whose fight just ended: not started again until the target changes.
    ended: Option<i32>,
}

impl Recorder {
    /// A timeline point is due on the next sample (so the caller fetches your skills).
    pub fn due(&self, now_ms: i64) -> bool {
        self.live.as_ref().map_or(true, |l| now_ms - l.last_point_ms >= POINT_MS)
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
        let live = self.live.get_or_insert_with(|| Live {
            fight: Fight { id: s.now_ms - s.time_ms, boss: s.name.clone(), code: s.code, low_pct: 100.0, ..Default::default() },
            target_id: s.target_id,
            last_total: -1.0,
            last_change_ms: s.now_ms,
            last_point_ms: i64::MIN / 2,
            point_totals: HashMap::new(),
        });
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
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Store { dir: dir.into() }
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

    /// Saves the fight, drops the oldest past `MAX_FIGHTS`, and updates your
    /// record. Returns the record it beat, if it beat one.
    pub fn save(&self, f: &Fight) -> std::io::Result<Option<NewBest>> {
        std::fs::create_dir_all(&self.dir)?;
        write_atomic(&self.fight_path(f.id), &serde_json::to_vec(f).unwrap_or_default())?;
        let mut idx = self.index();
        idx.retain(|e| e.id != f.id);
        idx.push(IndexEntry { id: f.id, boss: f.boss.clone(), code: f.code, won: f.won, duration_ms: f.duration_ms, low_pct: f.low_pct, my_dps: f.my_dps(), me: f.me.clone() });
        idx.sort_by_key(|e| e.id);
        while idx.len() > MAX_FIGHTS {
            let old = idx.remove(0);
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
            anchor_pct: None,
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
        // 40 s on a copy (boss-flagged, its own code, 100% HP): the Ludra's HP keeps falling.
        for s in 21..=60 {
            let copy = Sample { target_id: 99, code: 2921505, pct: Some(100.0), time_ms: (s - 20) * 1000, anchor_pct: Some(80.0 - (s - 20) as f64 * 0.2), ..sample(s * 1000, 99, 1000, 100.0, (5e3, 0.0)) };
            assert!(r.feed(&copy, None).is_empty(), "split at {s}");
        }
        assert_eq!(r.live.as_ref().unwrap().target_id, 7);
        // Back on the Ludra, which dies: one fight, the copy's damage not in it.
        let out = r.feed(&ludra(61_000, 61_000, 0.0, 9e5), None);
        assert_eq!(out.len(), 1);
        let f = &out[0];
        assert!(f.won && f.code == 2301014 && f.id == 0);
        assert_eq!(f.players[0].total, 9e5);
        assert!(f.low_pct == 0.0);
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
        // Pruning: past MAX_FIGHTS the oldest go, the record stays.
        for id in 10..(10 + MAX_FIGHTS as i64) {
            st.save(&fight(id, 1000.0)).unwrap();
        }
        let list = st.list();
        assert_eq!(list.len(), MAX_FIGHTS);
        assert!(st.get(1).is_none() && st.get(3).is_none());
        assert_eq!(st.bests()[0].id, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
