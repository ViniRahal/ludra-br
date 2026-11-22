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

/// "Quadro da party": one debuff an enemy put on a party member, live now.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Debuff {
    /// The game's abnormal id.
    pub id: u32,
    /// The name of the skill that put it on, in Portuguese ("" if not known).
    pub name: String,
    /// Seconds left by the server's timer (none: no timer, or not known).
    pub secs_left: Option<f64>,
    /// How many of it are on (stacks, or the same debuff from several casts).
    pub stacks: u32,
    /// Put on by an enemy (always true here: only those are listed).
    pub harmful: bool,
    /// Whether a cleanse can take it off (none: the game data we have doesn't say).
    pub cleansable: Option<bool>,
}

/// "Quadro da party": one member, in the game's party order (you first when
/// there is no party).
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Frame {
    pub name: String,
    pub class: String,
    pub me: bool,
    /// Their entity in the game (0: not seen yet, so no HP or debuffs).
    pub id: i32,
    pub level: i32,
    /// HP left, 0-100 (none: not known).
    pub hp_pct: Option<f64>,
    pub hp: i64,
    /// The highest HP seen for them (their max once they were at full).
    pub max_hp: i64,
    pub dead: bool,
    /// The boss is hitting them most (the boss panel's aggro).
    pub aggro: bool,
    pub debuffs: Vec<Debuff>,
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
    /// The party's frames: HP, death, aggro and enemies' debuffs.
    pub frames: Vec<Frame>,
}

/// "Detalhe do jogador": one skill of a player's, this fight.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct SkillRow {
    pub id: i32,
    pub name: String,
    pub total: f64,
    pub hits: i64,
    pub crit_pct: f64,
    /// Share of this player's damage, 0-100.
    pub share: f64,
    /// The biggest hit.
    pub max: f64,
    pub dps: f64,
}

/// Who hurt this player, and with what, this fight.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct TakenRow {
    pub from: String,
    pub skill: String,
    pub total: f64,
    pub hits: i64,
}

/// "Detalhe do jogador": what one player did and took in the meter's fight.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Detail {
    pub id: i32,
    pub name: String,
    pub class: String,
    pub me: bool,
    pub total: f64,
    pub dps: f64,
    pub time_ms: i64,
    pub crit_pct: f64,
    pub deaths: i32,
    pub skills: Vec<SkillRow>,
    pub taken: f64,
    pub taken_by: Vec<TakenRow>,
    pub heal_done: f64,
    pub heal_received: f64,
}

/// Hits players took this fight: victim -> (attacker, skill) -> (damage, hits).
type TakenSum = HashMap<i32, HashMap<(i32, i32), (i64, i64)>>;

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
    /// "Detalhe do jogador": the hits players took since the meter's target changed.
    taken_sum: Arc<Mutex<TakenSum>>,
    /// The last view's rows and fight time, for the detail.
    last_rows: Vec<Row>,
    last_time_ms: i64,
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
        let taken_sum: Arc<Mutex<TakenSum>> = Arc::new(Mutex::new(HashMap::new()));
        {
            let (taken, watched, taken_sum) = (taken.clone(), watched.clone(), taken_sum.clone());
            // Runs under the store's lock: only copies the hit.
            storage.set_on_hit(move |p| {
                if p.actor_id() == p.target_id() || !watched.read().contains(&p.target_id()) {
                    return;
                }
                record_taken(&taken, Taken { at: p.timestamp(), target: p.target_id(), actor: p.actor_id(), skill: p.skill_code(), damage: p.total_damage() as i64 });
                add_taken(&taken_sum, p.target_id(), p.actor_id(), p.skill_code(), p.total_damage() as i64);
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
            taken_sum,
            last_rows: Vec::new(),
            last_time_ms: 0,
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

    /// "Detalhe do jogador": `id`'s skills on the meter's target (A2Tools'
    /// own per-skill table, DoTs folded into their skill), and the damage they
    /// took this fight. None: not a player of the table.
    pub fn detail(&self, id: i32) -> Option<Detail> {
        let row = self.last_rows.iter().find(|r| r.id == id).cloned();
        let taken_by_raw: Vec<((i32, i32), (i64, i64))> = self.taken_sum.lock().get(&id).map(|m| m.iter().map(|(k, v)| (*k, *v)).collect()).unwrap_or_default();
        if row.is_none() && taken_by_raw.is_empty() {
            return None;
        }
        let time_ms = self.last_time_ms.max(0);
        let secs = (time_ms as f64 / 1000.0).max(1.0);
        let mut skills: Vec<SkillRow> = Vec::new();
        let (mut heal_done, mut hits_all, mut crits_all) = (0.0, 0i64, 0i64);
        if self.last_target != 0 {
            let resp = self.calc.get_target_details(self.last_target, None);
            // code -> (name, total, hits, crits, max)
            let mut by: HashMap<i32, (String, f64, i64, i64, f64)> = HashMap::new();
            for e in resp.skills.iter().filter(|e| e.actor_id == id) {
                let name = e.name.trim_end_matches(" - DOT").to_string();
                let s = by.entry(e.code).or_insert_with(|| (name.clone(), 0.0, 0, 0, 0.0));
                if s.0.is_empty() {
                    s.0 = name;
                }
                s.1 += e.dmg.max(0) as f64;
                if !e.is_dot {
                    s.2 += e.time as i64;
                    s.3 += e.crit as i64;
                }
                s.4 = s.4.max(e.max_dmg.max(0) as f64);
            }
            heal_done = resp.heal_skills.iter().filter(|e| e.actor_id == id).map(|e| e.dmg.max(0) as f64).sum();
            let sum: f64 = by.values().map(|s| s.1).sum();
            for (code, (name, total, hits, crits, max)) in by {
                hits_all += hits;
                crits_all += crits;
                skills.push(SkillRow {
                    id: code,
                    name: if name.is_empty() { format!("Habilidade {code}") } else { name },
                    total,
                    hits,
                    crit_pct: if hits > 0 { crits as f64 / hits as f64 * 100.0 } else { 0.0 },
                    share: if sum > 0.0 { total / sum * 100.0 } else { 0.0 },
                    max,
                    dps: total / secs,
                });
            }
            skills.sort_by(|a, b| b.total.partial_cmp(&a.total).unwrap_or(std::cmp::Ordering::Equal));
        }
        let mut taken_by: Vec<TakenRow> = taken_by_raw
            .iter()
            .map(|((actor, skill), (dmg, hits))| TakenRow { from: self.who(*actor), skill: self.skills.lookup_skill_name(*skill), total: *dmg as f64, hits: *hits })
            .collect();
        let taken: f64 = taken_by.iter().map(|t| t.total).sum();
        taken_by.sort_by(|a, b| b.total.partial_cmp(&a.total).unwrap_or(std::cmp::Ordering::Equal));
        taken_by.truncate(10);
        let (name, class, me, total, dps, deaths) = match &row {
            Some(r) => (r.name.clone(), r.class.clone(), r.me, r.total, r.dps, r.deaths),
            None => (self.storage.get_nickname(id).unwrap_or_default(), String::new(), self.storage.local_player_id() == Some(id as i64), 0.0, 0.0, 0),
        };
        Some(Detail {
            id,
            name,
            class,
            me,
            total,
            dps,
            time_ms,
            crit_pct: if hits_all > 0 { crits_all as f64 / hits_all as f64 * 100.0 } else { 0.0 },
            deaths,
            skills,
            taken,
            taken_by,
            heal_done,
            heal_received: 0.0,
        })
    }

    /// The party's frames now: the game's party list (you alone without one),
    /// each joined by name to their entity for its HP and enemies' debuffs.
    fn frames(&self, now_ms: i64, party: &[Member], me_info: Option<&Me>, me: Option<i32>, aggro: Option<i32>) -> Vec<Frame> {
        let mut ids: HashMap<String, i32> = HashMap::new();
        for (id, n) in self.storage.get_nicknames() {
            let n = n.trim();
            if !n.is_empty() {
                ids.insert(n.to_string(), id);
            }
        }
        if let (Some(m), Some(id)) = (me_info, me) {
            ids.insert(m.name.clone(), id);
        }
        let solo;
        let members: &[Member] = if party.is_empty() {
            solo = me_info.map(|m| vec![Member { name: m.name.clone(), class: m.class.clone(), level: m.level as i32, gs: m.gs, cp: m.cp, me: true }]).unwrap_or_default();
            &solo
        } else {
            party
        };
        let wanted: HashSet<i32> = members.iter().filter_map(|m| ids.get(m.name.trim()).copied()).collect();
        let debuffs = self.enemy_debuffs(now_ms, &wanted);
        let storage = &self.storage;
        frames_of(
            members,
            &ids,
            me,
            |id| (storage.get_mob_current_hp(id), storage.get_mob_hp(id)),
            |id| storage.is_entity_dead(id),
            aggro,
            &debuffs,
        )
    }

    /// What enemies have on these players now, by player: one entry per
    /// debuff, the soonest to end first.
    fn enemy_debuffs(&self, now_ms: i64, on: &HashSet<i32>) -> HashMap<i32, Vec<Debuff>> {
        let mut out: HashMap<i32, Vec<Debuff>> = HashMap::new();
        if on.is_empty() {
            return out;
        }
        let summons = self.storage.get_summon_data();
        let mut by: HashMap<(i32, u32), Debuff> = HashMap::new();
        for i in self.storage.abnormal_instances(now_ms - 120_000, now_ms) {
            if i.end_ms.is_some() || !on.contains(&i.entity) {
                continue;
            }
            let caster = a2tools::entity::summon_resolver::resolve(i.caster, &summons);
            if caster == i.entity || !self.storage.is_mob(caster) {
                continue;
            }
            let secs_left = i.server_end_ms.map(|e| (e - now_ms) as f64 / 1000.0).filter(|s| (0.0..=3600.0).contains(s)).map(|s| (s * 10.0).round() / 10.0);
            let e = by.entry((i.entity, i.abnormal)).or_insert_with(|| Debuff {
                id: i.abnormal,
                name: i.skill.map(|k| self.skills.lookup_skill_name(k as i32)).unwrap_or_default(),
                secs_left,
                stacks: 0,
                harmful: true,
                cleansable: None,
            });
            e.stacks += 1;
            if let Some(s) = secs_left {
                e.secs_left = Some(e.secs_left.map_or(s, |o: f64| o.max(s)));
            }
        }
        for ((entity, _), d) in by {
            out.entry(entity).or_default().push(d);
        }
        for list in out.values_mut() {
            list.sort_by(|a, b| a.secs_left.unwrap_or(f64::MAX).partial_cmp(&b.secs_left.unwrap_or(f64::MAX)).unwrap_or(std::cmp::Ordering::Equal).then(a.id.cmp(&b.id)));
        }
        out
    }

    /// The table now (call about once a second).
    pub fn view(&mut self, now_ms: i64) -> View {
        let d = self.calc.get_dps();
        if d.target_id != self.last_target {
            self.history.clear();
            // A new fight: its own "dano recebido" (not when the target is only lost).
            if d.target_id != 0 {
                self.taken_sum.lock().clear();
            }
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
        let aggro_id = if boss_id != 0 { self.aggro_of(boss_id, now_ms) } else { None };
        let boss = (boss_id != 0).then(|| {
            let aggro = aggro_id;
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
        let frames = self.frames(now_ms, &party, me_info.as_ref(), me, aggro_id);
        self.update_recaps(now_ms, &rows, &party, me);
        self.last_rows = rows.clone();
        self.last_time_ms = d.battle_time;
        View {
            recaps: self.recaps.iter().cloned().collect(),
            frames,
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

/// The frames for these members: `ids` joins a name to its entity, `hp`
/// gives an entity's (HP now, highest HP seen), `dead` whether it is down.
fn frames_of(
    members: &[Member],
    ids: &HashMap<String, i32>,
    me: Option<i32>,
    hp: impl Fn(i32) -> (Option<i32>, Option<i32>),
    dead: impl Fn(i32) -> bool,
    aggro: Option<i32>,
    debuffs: &HashMap<i32, Vec<Debuff>>,
) -> Vec<Frame> {
    members
        .iter()
        .map(|m| {
            let id = ids.get(m.name.trim()).copied().unwrap_or(0);
            let (cur, max) = if id != 0 { hp(id) } else { (None, None) };
            let max_hp = max.unwrap_or(0).max(cur.unwrap_or(0)) as i64;
            let hp_now = cur.map(|c| c.max(0) as i64);
            let hp_pct = match hp_now {
                Some(h) if max_hp > 0 => Some(((h as f64 / max_hp as f64) * 1000.0).round() / 10.0),
                _ => None,
            };
            Frame {
                name: m.name.clone(),
                class: m.class.clone(),
                me: m.me || (id != 0 && me == Some(id)),
                id,
                level: m.level,
                hp_pct,
                hp: hp_now.unwrap_or(0),
                max_hp,
                // A revive brings the HP back; the store's dead mark is only for when no HP came.
                dead: id != 0 && (hp_now == Some(0) || (hp_now.is_none() && dead(id))),
                aggro: id != 0 && aggro == Some(id),
                debuffs: debuffs.get(&id).cloned().unwrap_or_default(),
            }
        })
        .collect()
}

/// Keeps a hit a player took (at most a few thousand).
fn record_taken(taken: &Mutex<VecDeque<Taken>>, t: Taken) {
    let mut q = taken.lock();
    q.push_back(t);
    while q.len() > 4096 {
        q.pop_front();
    }
}

/// Adds a hit a player took to this fight's sums.
fn add_taken(sum: &Mutex<TakenSum>, target: i32, actor: i32, skill: i32, damage: i64) {
    let mut m = sum.lock();
    let e = m.entry(target).or_default().entry((actor, skill)).or_insert((0, 0));
    e.0 += damage;
    e.1 += 1;
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
    fn the_detail_sums_what_a_player_took() {
        let mut m = Meter::new();
        m.last_rows = vec![Row { id: 7, name: "Dark".into(), class: "assassin".into(), dps: 1000.0, now: 0.0, total: 60_000.0, share: 100.0, deaths: 1, cp: 0, me: true }];
        m.last_time_ms = 60_000;
        add_taken(&m.taken_sum, 7, 9000, 1803290, 40_000);
        add_taken(&m.taken_sum, 7, 9000, 1803290, 45_000);
        add_taken(&m.taken_sum, 7, 9000, 1803370, 10_000);
        let d = m.detail(7).expect("detail");
        assert_eq!((d.name.as_str(), d.me, d.deaths, d.time_ms), ("Dark", true, 1, 60_000));
        assert_eq!(d.taken, 95_000.0);
        assert_eq!(d.taken_by.len(), 2);
        assert_eq!((d.taken_by[0].total, d.taken_by[0].hits), (85_000.0, 2));
        // No target yet: no skills, but no crash.
        assert!(d.skills.is_empty());
        // Someone the meter never saw.
        assert!(m.detail(12345).is_none());
    }

    #[test]
    fn the_frames_join_the_party_to_its_hp_aggro_and_debuffs() {
        let party = vec![
            Member { name: "Mad".into(), class: "templar".into(), level: 45, gs: 3000, cp: 200_000, me: false },
            Member { name: "Eu".into(), class: "cleric".into(), level: 45, gs: 2900, cp: 190_000, me: true },
            Member { name: "Longe".into(), class: "ranger".into(), level: 45, gs: 2800, cp: 180_000, me: false },
        ];
        let ids: HashMap<String, i32> = [("Mad".to_string(), 10), ("Eu".to_string(), 20)].into_iter().collect();
        let hp = |id: i32| match id {
            10 => (Some(5_000), Some(20_000)),
            20 => (Some(0), Some(18_000)),
            _ => (None, None),
        };
        let mut debuffs = HashMap::new();
        debuffs.insert(10, vec![Debuff { id: 777, name: "Veneno".into(), secs_left: Some(4.5), stacks: 2, harmful: true, cleansable: None }]);
        let f = frames_of(&party, &ids, Some(20), hp, |_| false, Some(10), &debuffs);
        assert_eq!(f.len(), 3);
        assert_eq!((f[0].name.as_str(), f[0].id, f[0].hp_pct, f[0].aggro, f[0].dead), ("Mad", 10, Some(25.0), true, false));
        assert_eq!(f[0].debuffs[0].stacks, 2);
        assert!(f[1].me && f[1].dead && f[1].hp_pct == Some(0.0) && !f[1].aggro);
        // Not seen yet: nothing made up.
        assert_eq!((f[2].id, f[2].hp_pct, f[2].dead, f[2].debuffs.len()), (0, None, false, 0));
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
