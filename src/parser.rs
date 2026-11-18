//! The game's bytes, read for the five records Ludra BR needs, and nothing
//! else:
//!
//! - `8D <entity> 02 01 00 <u32 hp> 00 00 00 00`: a monster's current HP
//!   (standalone `00 8D` packets and the copies inside combat packets).
//! - `41 36`: a monster spawning, with its max HP.
//! - `09 38` / `02 38`: a skill's cast starting / going off.
//! - `2A 38`: a buff landing.
//!
//! The record layouts, the framing and the HP scan follow A2Tools DPS Meter
//! (GPL-3.0), `capture/stream_processor.rs`, where they are tested against
//! real captures. Only monsters of a boss's size and skills of the Abyssal
//! Forge bosses leave this module.

use super::framing::{self, FrameKind};
use super::tunnel::Unwrapper;
use serde::Serialize;
use std::collections::HashMap;

pub struct VarIntResult {
    pub value: i32,
    pub length: i32,
}

impl VarIntResult {
    pub fn invalid() -> Self {
        Self { value: -1, length: -1 }
    }
}

pub fn read_varint(bytes: &[u8], offset: usize) -> VarIntResult {
    let mut value: i32 = 0;
    let mut shift = 0;
    let mut count = 0;
    loop {
        if offset + count >= bytes.len() {
            return VarIntResult::invalid();
        }
        let byte_val = bytes[offset + count] as u32;
        count += 1;
        value |= ((byte_val & 0x7F) as i32) << shift;
        if byte_val & 0x80 == 0 {
            return VarIntResult { value, length: count as i32 };
        }
        shift += 7;
        if shift >= 32 {
            return VarIntResult::invalid();
        }
    }
}

/// What the page gets, in the shape the plugin's engine (logic.js) reads.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    /// `{ entity, kind: 2, count: 1, res: 0, hp }`
    Hp { entity: i64, kind: u8, count: u8, res: u8, hp: u64 },
    /// `code`: the monster's model code (the NPC id, e.g. Ludra 2300290).
    Spawn { entity: i64, max: u64, code: u32 },
    Cast { caster: i64, skill: u32 },
    Use { caster: i64, skill: u32 },
    Buff { entity: i64, abnormal: u32 },
    /// A boss-sized monster's hit on someone (`04 38`): who it is attacking.
    Hit { target: i64, actor: i64 },
}

/// Below this no monster is a boss (data.js `minBossHp`): its HP never leaves.
pub const MIN_BOSS_HP: u64 = 5_000_000;
/// A live HP this high is believed only for a monster whose spawn said so.
const HP_BOUND: u64 = 100_000_000;

/// The Abyssal Forge bosses' skills and buffs (data.js's ranges, a little
/// wider): Talisra/Ketu 1801xxx to Ludra 1803xxx, and their 8-digit variants.
/// The bosses Ludra BR knows by their model code, whatever their HP (a
/// dungeon's are far under a raid's): data.js's `codes`, kept the same.
pub const BOSS_CODES: &[u32] = &[
    // Abyssal Forge: Ludra (Normal, Hard): Ludra, Rahu, Ketu.
    2301014, 2300290, 2301006, 2300282, 2301007, 2300283,
    // Draupnir Cave: Saraswati, Lakshmi, Bakarma (Exploration, Conquest, Hard, other).
    2310403, 2300403, 2320403, 2330403, 2310401, 2300401, 2320401, 2330401, 2310471, 2300471, 2320471, 2330424, 2090428,
    // Urugugu Canyon: Raur, Urahum, Auldor.
    2310206, 2300206, 2320206, 2330206, 2310207, 2300207, 2320207, 2330207, 2310218, 2300218, 2320218, 2330218,
];

pub fn ours(id: u32) -> bool {
    (1_801_000..=1_803_999).contains(&id) || (18_010_000..=18_039_999).contains(&id)
}

#[derive(Default)]
pub struct Processor {
    tunnel: Unwrapper,
    /// Monsters seen at a boss's size: entity -> max HP from the spawn (0: none seen).
    big: HashMap<i32, u64>,
    pub events: Vec<Event>,
}

impl Processor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads what it can from the stream's buffered bytes; returns how many it used.
    pub fn consume_stream(&mut self, buffer: &[u8]) -> usize {
        if let Some(used) = self.tunnel.feed(buffer) {
            let game = self.tunnel.game().to_vec();
            let framed = self.consume_game(&game);
            self.tunnel.consumed(framed);
            return used;
        }
        self.consume_game(buffer)
    }

    fn consume_game(&mut self, buffer: &[u8]) -> usize {
        let walk = framing::walk(buffer);
        for frame in &walk.frames {
            framing::new_read();
            match frame.kind {
                FrameKind::Bundle => self.unwrap_bundle(frame.payload(buffer), 1),
                FrameKind::Packet => self.packet(frame.bytes(buffer)),
            }
        }
        self.scan_hp(&buffer[..walk.consumed]);
        self.scan_spawns(&buffer[..walk.consumed]);
        walk.consumed
    }

    fn unwrap_bundle(&mut self, payload: &[u8], depth: usize) {
        if payload.len() < 7 || depth > framing::MAX_BUNDLE_DEPTH {
            return;
        }
        let Some(data) = framing::decompress_bundle(payload) else { return };
        let walk = framing::walk_inner(&data);
        for frame in &walk.frames {
            match frame.kind {
                FrameKind::Bundle => self.unwrap_bundle(frame.payload(&data), depth + 1),
                FrameKind::Packet => self.packet(frame.bytes(&data)),
            }
        }
        self.scan_hp(&data);
        self.scan_spawns(&data);
    }

    /// One whole packet: `<varint length> <2-byte type> <body>`.
    fn packet(&mut self, packet: &[u8]) {
        let len = read_varint(packet, 0);
        if len.length <= 0 {
            return;
        }
        let at = len.length as usize;
        if at + 2 > packet.len() {
            return;
        }
        let body = &packet[at + 2..];
        match (packet[at], packet[at + 1]) {
            (0x09, 0x38) | (0x02, 0x38) => {
                if let Some((caster, skill)) = skill_record(body) {
                    if ours(skill) {
                        self.events.push(if packet[at] == 0x09 {
                            Event::Cast { caster, skill }
                        } else {
                            Event::Use { caster, skill }
                        });
                    }
                }
            }
            (0x04, 0x38) => {
                if let Some((target, actor, skill)) = hit_record(body) {
                    // A monster's skill (7 digits, or an 8-digit variant) from
                    // one of a boss's size, on someone else.
                    if (1_000_000..=99_999_999).contains(&skill) && actor != target && self.big.contains_key(&(actor as i32)) {
                        self.events.push(Event::Hit { target, actor });
                    }
                }
            }
            (0x2A, 0x38) => {
                if let Some((entity, abnormal)) = buff_record(body) {
                    if ours(abnormal) {
                        self.events.push(Event::Buff { entity, abnormal });
                    }
                }
            }
            _ => {}
        }
    }

    /// Every monster spawn (`41 36`) in `data`, at a packet's start or inside
    /// another (bosses come in bundles of records: A2Tools'
    /// `scan_for_embedded_40_36`). A `00` before it is a length's tail, not a spawn.
    fn scan_spawns(&mut self, data: &[u8]) {
        let mut i = 0;
        while i + 5 < data.len() {
            if data[i] == 0x41 && data[i + 1] == 0x36 && !(i > 0 && data[i - 1] == 0x00) {
                if let Some((entity, max, code)) = spawn_record(&data[i + 2..]) {
                    let known = BOSS_CODES.contains(&code);
                    if (max >= MIN_BOSS_HP || known) && self.big.get(&(entity as i32)) != Some(&max) {
                        self.big.insert(entity as i32, max);
                        self.events.push(Event::Spawn { entity, max, code });
                    }
                }
                i += 2;
                continue;
            }
            i += 1;
        }
    }

    /// Every `8D <id> 02 01 00 <u32 hp> 00 00 00 00` in `data` (A2Tools'
    /// `scan_for_entity_hp`): the trailing zeros are required, or a look-alike
    /// record reads as a huge HP.
    fn scan_hp(&mut self, data: &[u8]) {
        let mut i = 0;
        while i + 1 < data.len() {
            if data[i] != 0x8D {
                i += 1;
                continue;
            }
            let id = read_varint(data, i + 1);
            if id.length <= 0 || !(100..=9_999_999).contains(&id.value) {
                i += 1;
                continue;
            }
            let d = i + 1 + id.length as usize;
            if d + 11 > data.len() {
                i += 1;
                continue;
            }
            if data[d..d + 3] == [0x02, 0x01, 0x00] && data[d + 7..d + 11] == [0, 0, 0, 0] {
                let hp = u32::from_le_bytes([data[d + 3], data[d + 4], data[d + 5], data[d + 6]]) as u64;
                let spawn_max = self.big.get(&id.value).copied();
                let bound = spawn_max.unwrap_or(0).max(HP_BOUND);
                // A boss-sized monster, or one already known as one (its HP
                // going down to the kill). Players and small monsters: dropped.
                if hp <= bound && (hp >= MIN_BOSS_HP || spawn_max.is_some()) {
                    self.big.entry(id.value).or_insert(0);
                    self.events.push(Event::Hp { entity: id.value as i64, kind: 2, count: 1, res: 0, hp });
                }
                i = d + 11;
                continue;
            }
            i += 1;
        }
        if self.big.len() > 4096 {
            self.big.clear();
        }
    }
}

/// `09 38` / `02 38`: `<caster varint> <1 byte> <skill u32 LE>`.
fn skill_record(body: &[u8]) -> Option<(i64, u32)> {
    let caster = read_varint(body, 0);
    if caster.length <= 0 {
        return None;
    }
    let at = caster.length as usize + 1;
    let b = body.get(at..at + 4)?;
    Some((caster.value as i64, u32::from_le_bytes([b[0], b[1], b[2], b[3]])))
}

/// `04 38`: `<target varint> <switch varint> <flag varint> <actor varint>
/// <skill u32 LE>` (A2Tools' `parsing_damage`).
fn hit_record(body: &[u8]) -> Option<(i64, i64, u32)> {
    let target = read_varint(body, 0);
    if target.length <= 0 || !(100..=9_999_999).contains(&target.value) {
        return None;
    }
    let mut at = target.length as usize;
    let switch = read_varint(body, at);
    if switch.length <= 0 {
        return None;
    }
    let kind = switch.value & 0x0F;
    if !matches!(kind, 0 | 2 | 4..=7) {
        return None;
    }
    at += switch.length as usize;
    let flag = read_varint(body, at);
    if flag.length <= 0 {
        return None;
    }
    at += flag.length as usize;
    let actor = read_varint(body, at);
    if actor.length <= 0 || !(100..=9_999_999).contains(&actor.value) {
        return None;
    }
    at += actor.length as usize;
    let b = body.get(at..at + 4)?;
    Some((target.value as i64, actor.value as i64, u32::from_le_bytes([b[0], b[1], b[2], b[3]])))
}

/// `2A 38`: `<entity varint> <1 byte> <flags u8> <instance varint> <abnormal u32 LE>`.
fn buff_record(body: &[u8]) -> Option<(i64, u32)> {
    let entity = read_varint(body, 0);
    if entity.length <= 0 {
        return None;
    }
    let inst_at = entity.length as usize + 2;
    let inst = read_varint(body, inst_at);
    if inst.length <= 0 {
        return None;
    }
    let at = inst_at + inst.length as usize;
    let b = body.get(at..at + 4)?;
    Some((entity.value as i64, u32::from_le_bytes([b[0], b[1], b[2], b[3]])))
}

/// `41 36 <entity varint> ...`: the model code sits before `00 (00|40) 02`,
/// and a little after it `01 <current varint> <max varint>` (A2Tools'
/// `spawn_mob_code` and `extract_and_register_mob_type`).
fn spawn_record(body: &[u8]) -> Option<(i64, u64, u32)> {
    let entity = read_varint(body, 0);
    if entity.length <= 0 || !(100..=9_999_999).contains(&entity.value) {
        return None;
    }
    let start = entity.length as usize;
    let end = body.len().saturating_sub(2).min(start + 60);
    let mut code_at = None;
    for s in start..end {
        if body[s] == 0x00 && (body[s + 1] == 0x40 || body[s + 1] == 0x00) && body[s + 2] == 0x02 {
            if s >= start + 3 {
                code_at = Some(s);
            }
            break;
        }
    }
    let code_at = code_at?;
    let code = body[code_at - 3] as u32 | (body[code_at - 2] as u32) << 8 | (body[code_at - 1] as u32) << 16;
    let mut s = code_at + 3;
    let hp_end = body.len().saturating_sub(2).min(s + 64);
    while s < hp_end {
        if body[s] == 0x01 {
            let cur = read_varint(body, s + 1);
            if cur.length > 0 && cur.value > 0 {
                let max = read_varint(body, s + 1 + cur.length as usize);
                if max.length > 0 && max.value >= cur.value {
                    return Some((entity.value as i64, max.value as u64, code));
                }
            }
        }
        s += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn varint(mut v: u32) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let b = (v & 0x7F) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return out;
            }
            out.push(b | 0x80);
        }
    }

    pub fn packet(op: [u8; 2], body: &[u8]) -> Vec<u8> {
        let mut payload = op.to_vec();
        payload.extend_from_slice(body);
        let mut v = varint(framing::length_value(payload.len()));
        v.extend_from_slice(&payload);
        v
    }

    pub fn hp_body(entity: u32, hp: u32) -> Vec<u8> {
        let mut b = varint(entity);
        b.extend_from_slice(&[0x02, 0x01, 0x00]);
        b.extend_from_slice(&hp.to_le_bytes());
        b.extend_from_slice(&[0, 0, 0, 0]);
        b
    }

    #[test]
    fn reads_boss_hp_and_drops_players() {
        let mut p = Processor::new();
        let mut s = packet([0x00, 0x8D], &hp_body(5000, 120_000_000 / 2));
        s.extend(packet([0x00, 0x8D], &hp_body(6000, 40_000)));
        let used = p.consume_stream(&s);
        assert_eq!(used, s.len());
        assert_eq!(p.events, vec![Event::Hp { entity: 5000, kind: 2, count: 1, res: 0, hp: 60_000_000 }]);
    }

    #[test]
    fn keeps_a_known_boss_under_the_floor() {
        let mut p = Processor::new();
        p.consume_stream(&packet([0x00, 0x8D], &hp_body(5000, 9_000_000)));
        p.consume_stream(&packet([0x00, 0x8D], &hp_body(5000, 1_000_000)));
        assert_eq!(p.events.len(), 2);
    }

    #[test]
    fn reads_casts_and_skips_others() {
        let mut p = Processor::new();
        let mut body = varint(5000);
        body.push(0);
        body.extend_from_slice(&1_803_040u32.to_le_bytes());
        let mut other = varint(77);
        other.push(0);
        other.extend_from_slice(&11_000_000u32.to_le_bytes());
        let mut s = packet([0x09, 0x38], &body);
        s.extend(packet([0x02, 0x38], &other));
        s.extend(packet([0x02, 0x38], &body));
        p.consume_stream(&s);
        assert_eq!(p.events, vec![Event::Cast { caster: 5000, skill: 1_803_040 }, Event::Use { caster: 5000, skill: 1_803_040 }]);
    }

    #[test]
    fn reads_inside_bundles_and_embedded() {
        let mut p = Processor::new();
        // A combat packet carrying an HP record mid-body, inside a bundle.
        let mut inner_body = vec![0x11, 0x22, 0x33];
        inner_body.push(0x8D);
        inner_body.extend(hp_body(4321, 77_000_000));
        let inner = packet([0x04, 0x38], &inner_body);
        let mut bundle = vec![0xFF, 0xFF];
        bundle.extend_from_slice(&(inner.len() as u32).to_le_bytes());
        bundle.extend_from_slice(&lz4_flex::compress(&inner));
        let mut s = varint(framing::length_value(bundle.len()));
        s.extend(bundle);
        p.consume_stream(&s);
        assert!(p.events.contains(&Event::Hp { entity: 4321, kind: 2, count: 1, res: 0, hp: 77_000_000 }), "{:?}", p.events);
    }

    #[test]
    fn reads_a_spawn_max() {
        let mut p = Processor::new();
        let mut body = varint(5000);
        body.extend_from_slice(&[0x0C, 0, 0, 0, 0x00, 0x12, 0x34, 0x56, 0x00, 0x40, 0x02, 0x10, 0x20, 0x30]);
        body.push(0x01);
        body.extend(varint(150_000_000));
        body.extend(varint(150_000_000));
        body.extend_from_slice(&[0, 0, 0]);
        p.consume_stream(&packet([0x41, 0x36], &body));
        assert_eq!(p.events, vec![Event::Spawn { entity: 5000, max: 150_000_000, code: 0x563412 }]);
        // Its HP above the plain bound is now believed.
        p.events.clear();
        p.consume_stream(&packet([0x00, 0x8D], &hp_body(5000, 149_000_000)));
        assert_eq!(p.events.len(), 1);
    }

    fn hex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Real records, from A2Tools' tests: Bakarma's spawn (600,000 HP, a
    /// packet of its own) and Ritualist Garshim's (160 million, inside a
    /// bundle after another record's bytes).
    #[test]
    fn reads_real_spawns() {
        let bak = hex("8f024136fbaa030c220047412300000200d89f47001ca2c6004c38460000874300c001c0cf24c0cf24640000006400000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000604110181969800ffffffffffffffff8075d52abb030000fbaa03013000d89f47001ca2c6004c3846110284969800ffffffffffffffff8075d52abb030000fbaa030100d89f47001ca2c6004c38461103bc060000ffffffffffffffff8075d52abb030000fbaa030100d89f47001ca2c6004c38461106d6010000ffffffffffffffff8075d52abb030000fbaa030100d89f47001ca2c6004c384601002d00000003012800000028000000437253c900");
        let at = bak.windows(2).position(|w| w == [0x41, 0x36]).unwrap();
        assert_eq!(spawn_record(&bak[at + 2..]), Some((54651, 600_000, 2_310_471)));
        // Bakarma (Draupnir, a dungeon boss of 600,000 HP) is known by its code.
        let mut p = Processor::new();
        p.scan_spawns(&bak);
        assert_eq!(p.events, vec![Event::Spawn { entity: 54651, max: 600_000, code: 2_310_471 }]);
        let mut p = Processor::new();
        p.scan_spawns(&hex("111D37860C2F03E5D502ED90F3910A4736FC2E01000A473690750100BF014136A3E3010420006D0B20000002C5ACD1C6D4E19B460064904649E7034273170180D0A54C80D0A54C640000006400000200025F"));
        assert_eq!(p.events, vec![Event::Spawn { entity: 29091, max: 160_000_000, code: 2_100_077 }]);
    }

    /// A real live-HP packet (a Training Scarecrow, entity 25839), with a boss's HP put in.
    #[test]
    fn reads_a_real_hp_packet() {
        let mut p = Processor::new();
        let s = hex("1400 8DEFC901 020100 0008AF2F 00000000"); // 800 million, no spawn: refused
        assert_eq!(p.consume_stream(&s), s.len());
        assert!(p.events.is_empty());
        let s = hex("1400 8DEFC901 020100 00E1F505 00000000"); // 100 million
        p.consume_stream(&s);
        assert_eq!(p.events, vec![Event::Hp { entity: 25839, kind: 2, count: 1, res: 0, hp: 100_000_000 }]);
    }

    #[test]
    fn a_split_stream_waits_for_the_rest() {
        let mut p = Processor::new();
        let s = packet([0x00, 0x8D], &hp_body(5000, 60_000_000));
        let used = p.consume_stream(&s[..5]);
        assert_eq!(used, 0);
        assert_eq!(p.consume_stream(&s), s.len());
        assert_eq!(p.events.len(), 1);
    }

    /// A real monster hit (A2Tools' test: Gatekeeper Pinopi, entity 47573,
    /// hitting player 9681 for 1,258 with skill 1607550): a boss-sized
    /// monster's hit names whom it attacks; a small one's is dropped.
    #[test]
    fn reads_whom_a_boss_hits() {
        let body = hex("D14B0600D5F3027E871800020202000243ED940901000000904EEA090100");
        assert_eq!(hit_record(&body), Some((9681, 47573, 1_607_550)));
        let mut p = Processor::new();
        p.consume_stream(&packet([0x04, 0x38], &body));
        assert!(p.events.is_empty());
        p.consume_stream(&packet([0x00, 0x8D], &hp_body(47573, 90_000_000)));
        p.events.clear();
        p.consume_stream(&packet([0x04, 0x38], &body));
        assert_eq!(p.events, vec![Event::Hit { target: 9681, actor: 47573 }]);
    }
}
