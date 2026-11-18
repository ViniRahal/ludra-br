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
use std::sync::Arc;

const NPCS_PT: &str = include_str!("../vendor/a2tools/src/data/i18n/npcs/pt.json");
const SKILLS_PT: &str = include_str!("../vendor/a2tools/src/data/i18n/skills/pt.json");
const DOT_IDS: &str = include_str!("../vendor/a2tools/src/data/dot_skill_ids.json");
/// "Agora": the damage of the last this many ms.
const NOW_WINDOW_MS: i64 = 10_000;
/// The aggro: the boss's hits of the last this many ms.
const AGGRO_WINDOW_MS: i64 = 8_000;

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

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct View {
    pub me: Option<Me>,
    pub party: Vec<Member>,
    /// Your ping to the game server, in ms.
    pub ping: Option<i32>,
    pub target: String,
    pub target_id: i32,
    pub time_ms: i64,
    pub dps: f64,
    pub rows: Vec<Row>,
    pub boss: Option<Boss>,
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
        Meter { storage, skills, npcs, dots, calc, history: VecDeque::new(), last_target: 0, hits: VecDeque::new(), ping }
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
        View {
            me: me_info,
            party: party.into_iter().map(|(_, m)| m).collect(),
            ping: self.ping.current_ping_ms(),
            target: d.target_name.clone(),
            target_id: d.target_id,
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
