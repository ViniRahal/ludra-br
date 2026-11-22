//! The damage meter: who hit the boss for how much. The reading is A2Tools
//! DPS Meter's own (GPL-3.0, vendored in vendor/a2tools): its parser, its
//! store and its DPS calculator, the same code that meter and its log site
//! run, so the numbers match theirs. This module only feeds it the game's
//! bytes and turns its table into rows for the page.

use a2tools::capture::stream_assembler::StreamAssembler;
use a2tools::capture::stream_processor::StreamProcessor;
use a2tools::combat::data_storage::DataStorage;
use a2tools::combat::dps_calculator::DpsCalculator;
use a2tools::combat::ping_tracker::PingTracker;
use a2tools::i18n::lookup::{NpcLookup, SkillLookup};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use parking_lot::{Mutex, RwLock};
use std::sync::Arc;

const NPCS_PT: &str = include_str!("../vendor/a2tools/src/data/i18n/npcs/pt.json");
const SKILLS_PT: &str = include_str!("../vendor/a2tools/src/data/i18n/skills/pt.json");
const DOT_IDS: &str = include_str!("../vendor/a2tools/src/data/dot_skill_ids.json");
/// "Agora": the damage of the last this many ms.
const NOW_WINDOW_MS: i64 = 10_000;
/// The aggro: the boss's hits of the last this many ms.
const AGGRO_WINDOW_MS: i64 = 8_000;
/// "O que te matou": the hits on players kept, this long back.
const TAKEN_KEEP_MS: i64 = 60_000;
/// A death is shown this long.
const RECAP_KEEP_MS: i64 = 120_000;
/// Recaps shown at most, and hits in each.
const MAX_RECAPS: usize = 20;
const RECAP_HITS: usize = 8;
/// A pause this long between two hits starts the burst that killed them.
const BURST_GAP_MS: i64 = 5_000;
/// "Dano recebido": the last this many ms before the death.
const TAKEN_WINDOW_MS: i64 = 10_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Row {
    pub id: i32,
    pub name: String,
    /// gladiator, templar, ... (the icon's file name), or "" when not known yet.
    pub class: String,
    pub dps: f64,
    /// The last 10 seconds' damage per second.
    pub now: f64,
    pub total: f64,
    /// Share of the group's damage, 0-100.
    pub share: f64,
    pub deaths: i32,
    pub cp: i64,
    pub me: bool,
}

/// The boss panel's part: whom the boss is attacking, and its stagger gauge.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Boss {
    pub id: i32,
    /// How far the stagger gauge is worn down, 0-100 (None: no gauge seen).
    pub stagger: Option<f64>,
    /// Who has the aggro: the one the boss hit most in the last seconds.
    pub aggro: String,
    pub aggro_class: String,
    pub aggro_me: bool,
}

/// Who the program has found you are playing (after a teleport or a login).
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Me {
    pub name: String,
    pub class: String,
    pub cp: i64,
    pub gs: i32,
    pub level: u32,
    pub server: u16,
}

/// One of your party, from the game's party list (before any fight too).
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Member {
    pub name: String,
    pub class: String,
    pub level: i32,
    pub gs: i32,
    pub cp: i64,
    pub me: bool,
}

/// A hit a player took: (at, victim, attacker, skill, damage).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Taken {
    at: i64,
    target: i32,
    actor: i32,
    skill: i32,
    damage: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct RecapHit {
    /// How long before the death.
    pub before_ms: i64,
    pub from: String,
    pub skill: String,
    pub damage: i64,
}

/// "O que te matou": one player's death, with what did it.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Recap {
    pub seq: u64,
    pub id: i32,
    pub name: String,
    pub class: String,
    pub me: bool,
    pub at_ms: i64,
    /// Who dealt the killing blow ("" not known).
    pub killer: String,
    /// The killing blow's skill, in Portuguese ("" not known).
    pub skill: String,
    pub skill_id: i32,
    pub damage: i64,
    /// From the first hit of the burst that killed them to the death.
    pub window_ms: i64,
    /// Damage taken in the last 10 s.
    pub taken: i64,
    /// The last hits taken, oldest first.
    pub hits: Vec<RecapHit>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct View {
    pub me: Option<Me>,
    /// Your entity in the game (0: not known yet).
    pub me_id: i32,
    pub party: Vec<Member>,
    /// Your ping to the game server, in ms.
    pub ping: Option<i32>,
    pub target: String,
    pub target_id: i32,
    /// The target is a boss (any boss of the game, from its model code).
    pub target_boss: bool,
    /// The target's HP: % left and the HP now (none: not known).
    pub target_pct: Option<f64>,
    pub target_hp: i64,
    /// The target's model code (which boss, and which difficulty).
    pub target_code: i32,
    pub time_ms: i64,
    pub dps: f64,
    pub rows: Vec<Row>,
    pub boss: Option<Boss>,
    /// Deaths of the last minutes, newest last.
    pub recaps: Vec<Recap>,
}

pub struct Meter {
    storage: Arc<DataStorage>,
    skills: Arc<SkillLookup>,
    npcs: Arc<NpcLookup>,
    dots: HashSet<i32>,
    calc: DpsCalculator,
    history: VecDeque<(i64, HashMap<i32, f64>)>,
    last_target: i32,
    /// A boss-sized monster's hits: (at, actor, target), the last few seconds.
    hits: VecDeque<(i64, i32, i32)>,
    ping: Arc<PingTracker>,
    /// Hits players took (filled by the store's hit hook).
    taken: Arc<Mutex<VecDeque<Taken>>>,
    /// The players whose hits are kept: you, your party, the meter's rows.
    watched: Arc<RwLock<HashSet<i32>>>,
    recaps: VecDeque<Recap>,
    /// Deaths already turned into a recap: (victim, time).
    recapped: HashSet<(i32, i64)>,
    seq: u64,
}

fn class_name(c: Option<a2tools::entity::job_class::JobClass>) -> String {
    match c.map(|c| format!("{c:?}").to_lowercase()).as_deref() {
        Some("elementalist") => "spiritmaster".to_string(),
        Some(c) => c.to_string(),
        None => String::new(),
    }
}

/// The game's Korean class names, as the calculator gives them.
fn class_of(job: &str) -> &'static str {
    match job {
        "검성" => "gladiator",
        "수호성" => "templar",
        "궁성" => "ranger",
        "살성" => "assassin",
        "마도성" => "sorcerer",
        "치유성" => "cleric",
        "정령성" => "spiritmaster",
        "호법성" => "chanter",
        "권성" => "fighter",
        _ => "",
    }
}

impl Meter {
    pub fn new() -> Self {
        let storage = Arc::new(DataStorage::new());
        let skills = Arc::new(SkillLookup::new());
        skills.load_from_json(SKILLS_PT);
        let npcs = Arc::new(NpcLookup::new());
        npcs.load_from_json(NPCS_PT);
        let dots = serde_json::from_str::<Vec<i32>>(DOT_IDS).unwrap_or_default().into_iter().collect();
        let ping = Arc::new(PingTracker::new());
        let calc = DpsCalculator::new(storage.clone(), skills.clone(), npcs.clone(), ping.clone());
        let taken: Arc<Mutex<VecDeque<Taken>>> = Arc::new(Mutex::new(VecDeque::new()));
        let watched: Arc<RwLock<HashSet<i32>>> = Arc::new(RwLock::new(HashSet::new()));
        {
            let (taken, watched) = (taken.clone(), watched.clone());
            // Runs under the store's lock: only copies the hit.
            storage.set_on_hit(move |p| {
                if p.actor_id() == p.target_id() || !watched.read().contains(&p.target_id()) {
                    return;
                }
                record_taken(&taken, Taken { at: p.timestamp(), target: p.target_id(), actor: p.actor_id(), skill: p.skill_code(), damage: p.total_damage() as i64 });
            });
        }
        Meter {
            storage,
            skills,
            npcs,
            dots,
            calc,
            history: VecDeque::new(),
            last_target: 0,
            hits: VecDeque::new(),
            ping,
            taken,
            watched,
            recaps: VecDeque::new(),
            recapped: HashSet::new(),
            seq: 0,
        }
    }

    /// Who hit `actor`'s name: a monster's in Portuguese, else a player's nickname.
    fn who(&self, actor: i32) -> String {
        if let Some(code) = self.storage.mob_code(actor) {
            let n = self.npcs.get_npc_name(code);
            if !n.is_empty() {
                return n;
            }
        }
        self.storage.get_nickname(actor).unwrap_or_default()
    }

    /// The recap of `victim`'s death at `at`, from the hits they took.
    fn recap_of(&mut self, victim: i32, at: i64, name: String, class: String, me: bool) -> Recap {
        let mine: Vec<Taken> = self.taken.lock().iter().filter(|t| t.target == victim && t.at <= at + 500 && at - t.at <= TAKEN_KEEP_MS).copied().collect();
        // The burst: back from the death until a pause.
        let mut start = at;
        let mut prev = at;
        for t in mine.iter().rev() {
            if prev - t.at > BURST_GAP_MS {
                break;
            }
            start = t.at;
            prev = t.at;
        }
        let last = mine.last().copied();
        let hits = mine
            .iter()
            .skip(mine.len().saturating_sub(RECAP_HITS))
            .map(|t| RecapHit { before_ms: (at - t.at).max(0), from: self.who(t.actor), skill: self.skills.lookup_skill_name(t.skill), damage: t.damage })
            .collect();
        self.seq += 1;
        Recap {
            seq: self.seq,
            id: victim,
            name,
            class,
            me,
            at_ms: at,
            killer: last.map(|t| self.who(t.actor)).unwrap_or_default(),
            skill: last.map(|t| self.skills.lookup_skill_name(t.skill)).unwrap_or_default(),
            skill_id: last.map(|t| t.skill).unwrap_or(0),
            damage: last.map(|t| t.damage).unwrap_or(0),
            window_ms: if last.is_some() { (at - start).max(0) } else { 0 },
            taken: mine.iter().filter(|t| at - t.at <= TAKEN_WINDOW_MS).map(|t| t.damage).sum(),
            hits,
        }
    }

    /// New deaths of the watched players into recaps; old ones out.
    fn update_recaps(&mut self, now_ms: i64, rows: &[Row], party: &[Member], me: Option<i32>) {
        let names = self.storage.get_nicknames();
        let party_names: HashSet<&str> = party.iter().map(|m| m.name.as_str()).collect();
        let mut watched: HashSet<i32> = rows.iter().map(|r| r.id).collect();
        watched.extend(me);
        watched.extend(names.iter().filter(|(_, n)| party_names.contains(n.trim())).map(|(id, _)| *id));
        *self.watched.write() = watched.clone();
        for (victim, at, _) in self.storage.deaths_between(now_ms - RECAP_KEEP_MS, now_ms + 1_000) {
            if !watched.contains(&victim) || !self.recapped.insert((victim, at)) {
                continue;
            }
            let row = rows.iter().find(|r| r.id == victim);
            let name = row.map(|r| r.name.clone()).or_else(|| names.get(&victim).map(|n| n.trim().to_string())).unwrap_or_else(|| format!("#{victim}"));
            let class = row.map(|r| r.class.clone()).filter(|c| !c.is_empty()).or_else(|| party.iter().find(|m| m.name == name).map(|m| m.class.clone())).unwrap_or_default();
            let recap = self.recap_of(victim, at, name, class, me == Some(victim));
            self.recaps.push_back(recap);
        }
        while self.recaps.len() > MAX_RECAPS || self.recaps.front().is_some_and(|r| now_ms - r.at_ms > RECAP_KEEP_MS) {
            self.recaps.pop_front();
        }
        self.recapped.retain(|(_, at)| now_ms - at <= RECAP_KEEP_MS * 2);
        let mut taken = self.taken.lock();
        while taken.front().is_some_and(|t| now_ms - t.at > TAKEN_KEEP_MS) {
            taken.pop_front();
        }
    }

    /// A segment of the game's connection, either way: for the ping.
    pub fn ping_packet(&self, src_port: u16, dst_port: u16, data: &[u8], at_ms: i64, server_port: u16) {
        let cap = a2tools::capture::captured_payload::CapturedPayload {
            src_port,
            dst_port,
            data: data.to_vec(),
            device_name: None,
            captured_at_ms: at_ms,
            src_ip: None,
            dst_ip: None,
            tcp_seq: 0,
            tcp_ack: 0,
        };
        self.ping.on_packet(&cap, server_port);
    }

    /// A reader for one connection's bytes, writing into this meter's store.
    pub fn reader(&self) -> Reader {
        let mut proc = StreamProcessor::new(self.storage.clone(), self.skills.clone(), self.npcs.clone());
        proc.set_dot_skill_ids(self.dots.clone());
        Reader { assembler: StreamAssembler::new(), proc }
    }

    /// A boss-sized monster hit someone (`Event::Hit`).
    pub fn hit(&mut self, target: i64, actor: i64, at_ms: i64) {
        self.hits.push_back((at_ms, actor as i32, target as i32));
        while self.hits.len() > 512 || self.hits.front().is_some_and(|h| at_ms - h.0 > AGGRO_WINDOW_MS) {
            self.hits.pop_front();
        }
    }

    /// Whom `boss` hit most in the last seconds (ties: the latest).
    fn aggro_of(&self, boss: i32, now_ms: i64) -> Option<i32> {
        let mut count: HashMap<i32, (u32, i64)> = HashMap::new();
        for &(at, actor, target) in &self.hits {
            if actor == boss && now_ms - at <= AGGRO_WINDOW_MS {
                let e = count.entry(target).or_insert((0, 0));
                e.0 += 1;
                e.1 = e.1.max(at);
            }
        }
        count.into_iter().max_by_key(|(_, (n, at))| (*n, *at)).map(|(t, _)| t)
    }

    /// The table now (call about once a second).
    pub fn view(&mut self, now_ms: i64) -> View {
        let d = self.calc.get_dps();
        if d.target_id != self.last_target {
            self.history.clear();
            self.last_target = d.target_id;
        }
        let me = d.local_player_id.map(|v| v as i32);
        let totals: HashMap<i32, f64> = d.map.iter().map(|(id, p)| (*id, p.amount)).collect();
        self.history.push_back((now_ms, totals.clone()));
        while self.history.len() > 2 && now_ms - self.history[1].0 >= NOW_WINDOW_MS {
            self.history.pop_front();
        }
        let (t0, old) = self.history.front().cloned().unwrap_or((now_ms, HashMap::new()));
        let span = ((now_ms - t0) as f64 / 1000.0).max(1.0);
        let group: f64 = d.map.values().map(|p| p.amount).sum();
        let mut rows: Vec<Row> = d
            .map
            .iter()
            .filter(|(_, p)| p.amount > 0.0 && !p.is_others)
            .map(|(id, p)| Row {
                id: *id,
                name: if p.nickname.is_empty() { format!("#{id}") } else { p.nickname.clone() },
                class: class_of(&p.job).to_string(),
                dps: p.dps,
                now: if now_ms - t0 >= 3000 { ((p.amount - old.get(id).copied().unwrap_or(0.0)) / span).max(0.0) } else { p.dps },
                total: p.amount,
                share: if group > 0.0 { p.amount / group * 100.0 } else { 0.0 },
                deaths: p.deaths,
                cp: p.combat_power,
                me: me == Some(*id),
            })
            .collect();
        rows.sort_by(|a, b| b.total.partial_cmp(&a.total).unwrap_or(std::cmp::Ordering::Equal));
        // The boss: the meter's target, else the last big monster that hit someone.
        let boss_id = if d.target_id != 0 { d.target_id } else { self.hits.back().map(|h| h.1).unwrap_or(0) };
        let boss = (boss_id != 0).then(|| {
            let aggro = self.aggro_of(boss_id, now_ms);
            let (name, class) = match aggro {
                Some(a) => match d.map.get(&a) {
                    Some(p) if !p.nickname.is_empty() => (p.nickname.clone(), class_of(&p.job).to_string()),
                    _ => (self.storage.get_nickname(a).unwrap_or_default(), String::new()),
                },
                None => (String::new(), String::new()),
            };
            Boss { id: boss_id, stagger: self.storage.stagger_pct(boss_id).map(|v| (v * 10.0).round() / 10.0), aggro: name, aggro_class: class, aggro_me: aggro.is_some() && aggro == me }
        });
        let lp = self.storage.local_profile();
        let me_info = lp.name.filter(|n| !n.trim().is_empty()).map(|name| Me {
            name: name.trim().to_string(),
            class: class_name(lp.class),
            cp: lp.combat_power.unwrap_or(0),
            gs: lp.gear_score.unwrap_or(0),
            level: lp.level.unwrap_or(0),
            server: lp.server_id,
        });
        let my_name = me_info.as_ref().map(|m| m.name.clone()).unwrap_or_default();
        let mut party: Vec<(u8, Member)> = self
            .storage
            .get_party_members()
            .into_iter()
            .map(|(name, p)| {
                let name = name.trim().to_string();
                (p.slot, Member { me: !my_name.is_empty() && name == my_name, name, class: class_name(p.job), level: p.level, gs: p.gear_score, cp: p.combat_power })
            })
            .collect();
        party.sort_by_key(|(slot, _)| *slot);
        // The target's HP: the game's own number, else its max less the damage seen.
        let target_hp = (d.target_max_hp > 0).then(|| {
            let h = if d.target_current_hp >= 0 { d.target_current_hp } else { d.target_max_hp - d.target_total_damage };
            h.clamp(0, d.target_max_hp)
        });
        let party: Vec<Member> = party.into_iter().map(|(_, m)| m).collect();
        self.update_recaps(now_ms, &rows, &party, me);
        View {
            recaps: self.recaps.iter().cloned().collect(),
            me: me_info,
            me_id: me.unwrap_or(0),
            party,
            ping: self.ping.current_ping_ms(),
            target: d.target_name.clone(),
            target_id: d.target_id,
            target_boss: d.target_is_boss,
            target_pct: target_hp.map(|h| ((h as f64 / d.target_max_hp as f64) * 1000.0).round() / 10.0),
            target_hp: target_hp.unwrap_or(0),
            target_code: d.target_mob_code,
            time_ms: d.battle_time,
            dps: rows.iter().map(|r| r.dps).sum(),
            rows,
            boss,
        }
    }
}

impl Default for Meter {
    fn default() -> Self {
        Self::new()
    }
}

/// Keeps a hit a player took (at most a few thousand).
fn record_taken(taken: &Mutex<VecDeque<Taken>>, t: Taken) {
    let mut q = taken.lock();
    q.push_back(t);
    while q.len() > 4096 {
        q.pop_front();
    }
}

pub struct Reader {
    assembler: StreamAssembler,
    proc: StreamProcessor,
}

impl Reader {
    pub fn bytes(&mut self, data: &[u8], at_ms: Option<i64>) {
        self.proc.set_override_timestamp(at_ms);
        self.assembler.process_chunk(data, &mut self.proc);
        self.proc.set_override_timestamp(None);
    }
    pub fn gap(&mut self) {
        self.assembler.lose_bytes();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// A real hit (A2Tools' test: 581 into a shield, Global EU 2026-10-06),
    /// framed as the stream carries it, read through the meter's reader.
    #[test]
    fn a_real_hit_reaches_the_store() {
        let m = Meter::new();
        let mut r = m.reader();
        let mut payload = vec![0x04, 0x38];
        payload.extend(hex("F3B7024600A17B680BC8001502000002D545244E02000000F462C50401C3414A070200"));
        let mut s = vec![(payload.len() + 4) as u8];
        s.extend(payload);
        r.bytes(&s, Some(1_000));
        let total: i64 = m.storage.get_combat_snapshot().values().flat_map(|t| t.actors.values()).map(|a| a.total_damage).sum();
        assert_eq!(total, 581);
    }

    #[test]
    fn a_death_names_the_blow_that_killed() {
        let mut m = Meter::new();
        let now = a2tools::clock::now_ms();
        let (me, ludra) = (9681, 47573);
        m.storage.append_mob(ludra, 2300290);
        // An old hit, then a pause, then the burst that kills.
        record_taken(&m.taken, Taken { at: now - 9_000, target: me, actor: ludra, skill: 1803040, damage: 1_000 });
        record_taken(&m.taken, Taken { at: now - 2_000, target: me, actor: ludra, skill: 1803040, damage: 20_000 });
        record_taken(&m.taken, Taken { at: now - 100, target: me, actor: ludra, skill: 1803030, damage: 90_000 });
        record_taken(&m.taken, Taken { at: now - 100, target: 1234, actor: ludra, skill: 1803030, damage: 5 });
        m.storage.note_hp(me, 50_000);
        m.storage.note_hp(me, 0);
        let row = Row { id: me, name: "Dark".into(), class: "assassin".into(), dps: 0.0, now: 0.0, total: 1.0, share: 0.0, deaths: 1, cp: 0, me: true };
        m.update_recaps(now, &[row.clone()], &[], Some(me));
        assert_eq!(m.recaps.len(), 1);
        let r = &m.recaps[0];
        assert_eq!((r.name.as_str(), r.me, r.skill_id, r.damage), ("Dark", true, 1803030, 90_000));
        assert!(!r.killer.is_empty(), "the boss's name");
        assert_eq!(r.taken, 111_000);
        assert_eq!(r.hits.len(), 3);
        assert!(r.window_ms >= 1_900 && r.window_ms <= 2_500, "{}", r.window_ms);
        // Seen again: no second recap.
        m.update_recaps(now + 1_000, &[row], &[], Some(me));
        assert_eq!(m.recaps.len(), 1);
        assert!(m.watched.read().contains(&me));
    }

    #[test]
    fn the_aggro_is_whom_the_boss_hits_most() {
        let mut m = Meter::new();
        for i in 0..5 {
            m.hit(100, 9000, 1_000 + i * 500);
        }
        m.hit(200, 9000, 3_600);
        m.hit(300, 7777, 3_700);
        assert_eq!(m.aggro_of(9000, 4_000), Some(100));
        // Long after: only the late hits count.
        m.hit(200, 9000, 12_000);
        assert_eq!(m.aggro_of(9000, 12_000), Some(200));
    }
}
