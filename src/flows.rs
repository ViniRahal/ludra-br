//! Which TCP connection is the game, and its bytes in order.
//!
//! No process list, no window search, no TCP table: the game's stream is told
//! apart by its own bytes, as A2Tools DPS Meter does (`capture_dispatcher`):
//! the record terminator `0E 00 36` comes many times a second from the game
//! server even when standing still, and nothing else sends it that often.

use super::meter::{Meter, Reader};
use super::parser::{Event, Processor};
use super::tcp_order::{Piece, TcpOrder};
use std::collections::HashMap;
use std::net::Ipv4Addr;

/// One TCP segment's payload, as captured.
#[derive(Debug, Clone)]
pub struct Segment {
    pub src_ip: Ipv4Addr,
    pub src_port: u16,
    pub dst_ip: Ipv4Addr,
    pub dst_port: u16,
    pub seq: u32,
    pub data: Vec<u8>,
    pub at_ms: i64,
}

const SIGNATURES: [&[u8]; 2] = [&[0x0E, 0x00, 0x36], &[0x06, 0x00, 0x36]];
const LOCK_HITS: u32 = 12;
const LOCK_WINDOW_MS: i64 = 3_000;
/// The game's stream quiet this long: it is gone (game shut, a move to another server).
const LOST_MS: i64 = 20_000;
const MAX_CANDIDATES: usize = 16;

type Key = (Ipv4Addr, u16, Ipv4Addr, u16); // server ip, server port, client ip, client port

struct Flow {
    order: TcpOrder,
    buf: Vec<u8>,
    after_gap: bool,
    proc: Processor,
    hits: u32,
    first_hit: i64,
    last: i64,
    tls: bool,
    /// The damage meter's reader of the same bytes.
    meter: Option<Reader>,
}

impl Flow {
    fn new(first: &[u8], at: i64, meter: Option<Reader>) -> Self {
        Flow {
            order: TcpOrder::default(),
            buf: Vec::with_capacity(64 * 1024),
            after_gap: false,
            proc: Processor::new(),
            hits: 0,
            first_hit: at,
            last: at,
            tls: is_tls(first),
            meter,
        }
    }

    fn feed(&mut self, seg: &Segment) {
        let pieces = if seg.seq == 0 { vec![Piece::Bytes(seg.data.clone())] } else { self.order.push(seg.seq, &seg.data, seg.at_ms) };
        for piece in pieces {
            match piece {
                Piece::Gap { .. } => {
                    if let Some(m) = &mut self.meter {
                        m.gap();
                    }
                    self.buf.clear();
                    self.after_gap = true;
                }
                Piece::Bytes(b) => {
                    if let Some(m) = &mut self.meter {
                        m.bytes(&b, Some(seg.at_ms));
                    }
                    if self.buf.len() > 2 * 1024 * 1024 {
                        self.buf.clear();
                    }
                    self.buf.extend_from_slice(&b);
                    if self.after_gap {
                        match super::framing::resync_start(&self.buf) {
                            Some(start) => {
                                self.buf.drain(..start);
                                self.after_gap = false;
                            }
                            None if self.buf.len() < 2 * super::framing::RESYNC_SEARCH => continue,
                            None => self.after_gap = false,
                        }
                    }
                    loop {
                        if self.buf.is_empty() {
                            break;
                        }
                        let used = self.proc.consume_stream(&self.buf);
                        if used == 0 {
                            break;
                        }
                        self.buf.drain(..used.min(self.buf.len()));
                    }
                }
            }
        }
    }
}

fn is_tls(d: &[u8]) -> bool {
    d.len() >= 3 && (0x14..=0x17).contains(&d[0]) && d[1] == 0x03 && d[2] <= 0x04
}

fn signed(d: &[u8]) -> bool {
    SIGNATURES.iter().any(|s| d.windows(s.len()).any(|w| w == *s))
}

/// What changed for the page.
#[derive(Debug, PartialEq)]
pub enum Status {
    Found { port: u16 },
    Lost,
}

#[derive(Default)]
pub struct Flows {
    flows: HashMap<Key, Flow>,
    locked: Option<Key>,
    pub meter: Option<Meter>,
}

impl Flows {
    pub fn new() -> Self {
        Self::default()
    }

    /// With the damage meter reading the game's stream too.
    pub fn with_meter() -> Self {
        Flows { meter: Some(Meter::new()), ..Self::default() }
    }

    pub fn locked(&self) -> bool {
        self.locked.is_some()
    }

    /// Reads one segment; returns the records found in it, and a change of
    /// whether the game was found.
    pub fn push(&mut self, seg: &Segment) -> (Vec<Event>, Option<Status>) {
        let mut status = None;
        // The game's connection, both ways, times the ping.
        if let (Some(lk), Some(m)) = (self.locked, self.meter.as_ref()) {
            let mine = (seg.src_ip, seg.src_port, seg.dst_ip, seg.dst_port) == lk;
            let back = (seg.dst_ip, seg.dst_port, seg.src_ip, seg.src_port) == lk;
            if mine || back {
                m.ping_packet(seg.src_port, seg.dst_port, &seg.data, seg.at_ms, lk.1);
            }
            if back {
                return (Vec::new(), None);
            }
        }
        // Server -> client only: a game server talks from a fixed port to the
        // client's high one. Either way round is tried until locked.
        let key: Key = (seg.src_ip, seg.src_port, seg.dst_ip, seg.dst_port);
        if let Some(lk) = self.locked {
            if key != lk {
                // A new connection with the signature: the game moved (a
                // channel or server change). Lost first, then found again.
                if !self.flows.contains_key(&key) && !signed(&seg.data) {
                    return (Vec::new(), None);
                }
            }
        }
        if self.locked.is_none() || Some(key) != self.locked {
            if !self.flows.contains_key(&key) {
                if !signed(&seg.data) {
                    return (Vec::new(), None);
                }
                if self.flows.len() >= MAX_CANDIDATES {
                    let quiet = self.flows.iter().filter(|(k, _)| Some(**k) != self.locked).min_by_key(|(_, f)| f.last).map(|(k, _)| *k);
                    if let Some(k) = quiet {
                        self.flows.remove(&k);
                    }
                }
                let reader = self.meter.as_ref().map(|m| m.reader());
                self.flows.insert(key, Flow::new(&seg.data, seg.at_ms, reader));
            }
        }
        let flow = self.flows.get_mut(&key).expect("inserted");
        flow.last = seg.at_ms;
        if flow.tls {
            return (Vec::new(), None);
        }
        if Some(key) != self.locked && signed(&seg.data) {
            if seg.at_ms - flow.first_hit > LOCK_WINDOW_MS {
                flow.hits = 0;
                flow.first_hit = seg.at_ms;
            }
            flow.hits += 1;
        }
        flow.feed(seg);
        let mut events = std::mem::take(&mut flow.proc.events);
        if Some(key) != self.locked {
            if flow.hits >= LOCK_HITS {
                self.locked = Some(key);
                self.flows.retain(|k, _| *k == key);
                status = Some(Status::Found { port: key.1 });
            } else {
                // Not the game (yet): what it held is not believed.
                events.clear();
            }
        }
        (events, status)
    }

    /// Called now and then: the game's stream gone quiet is the game gone.
    pub fn tick(&mut self, now_ms: i64) -> Option<Status> {
        let lk = self.locked?;
        let last = self.flows.get(&lk).map(|f| f.last).unwrap_or(0);
        if now_ms - last > LOST_MS {
            self.locked = None;
            self.flows.clear();
            return Some(Status::Lost);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(port: u16, seq: u32, data: Vec<u8>, at: i64) -> Segment {
        Segment { src_ip: Ipv4Addr::new(1, 2, 3, 4), src_port: port, dst_ip: Ipv4Addr::new(10, 0, 0, 2), dst_port: 50000, seq, data, at_ms: at }
    }

    fn varint(mut v: u32) -> Vec<u8> {
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

    fn packet(op: [u8; 2], body: &[u8]) -> Vec<u8> {
        let mut payload = op.to_vec();
        payload.extend_from_slice(body);
        let mut v = varint(super::super::framing::length_value(payload.len()));
        v.extend_from_slice(&payload);
        v
    }

    fn heartbeat() -> Vec<u8> {
        packet([0x10, 0x36], &[0x01, 0x0E, 0x00, 0x36, 0x05])
    }

    fn hp(entity: u32, hp: u32) -> Vec<u8> {
        let mut b = varint(entity);
        b.extend_from_slice(&[0x02, 0x01, 0x00]);
        b.extend_from_slice(&hp.to_le_bytes());
        b.extend_from_slice(&[0, 0, 0, 0]);
        packet([0x00, 0x8D], &b)
    }

    #[test]
    fn locks_on_the_game_and_reads_it() {
        let mut f = Flows::new();
        let mut seq = 1000u32;
        let mut found = None;
        for i in 0..12 {
            let d = heartbeat();
            let (_, s) = f.push(&seg(13328, seq, d.clone(), 1_000 + i * 50));
            seq += d.len() as u32;
            if s.is_some() {
                found = s;
            }
        }
        assert_eq!(found, Some(Status::Found { port: 13328 }));
        let d = hp(5000, 60_000_000);
        let (ev, _) = f.push(&seg(13328, seq, d, 2_000));
        assert_eq!(ev.len(), 1);
        // Another connection with no signature: ignored.
        let (ev, _) = f.push(&seg(443, 1, hp(5000, 50_000_000), 2_100));
        assert!(ev.is_empty());
        assert_eq!(f.tick(2_000 + LOST_MS + 1), Some(Status::Lost));
    }

    #[test]
    fn a_slow_drip_never_locks() {
        let mut f = Flows::new();
        let mut seq = 1u32;
        for i in 0..30 {
            let d = heartbeat();
            let (_, s) = f.push(&seg(16005, seq, d.clone(), i * 10_000));
            seq += d.len() as u32;
            assert!(s.is_none());
        }
    }
}
