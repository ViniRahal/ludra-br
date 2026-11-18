//! Reading this computer's network traffic through Npcap, the way every AION 2
//! meter does: a passive copy of what arrives, nothing sent, nothing changed,
//! the game's process never touched. The FFI, the link types and the TCP
//! parsing follow A2Tools DPS Meter (GPL-3.0), `capture/pcap_capturer.rs`.

use super::flows::Segment;
use std::ffi::{c_char, c_int, c_long, c_uint, CStr, CString};
use std::net::Ipv4Addr;
use std::ptr;
use std::sync::mpsc::SyncSender;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use libloading::Library;

type PcapT = *mut std::ffi::c_void;

#[repr(C)]
struct PcapIf {
    next: *mut PcapIf,
    name: *const c_char,
    description: *const c_char,
    addresses: *mut std::ffi::c_void,
    flags: c_uint,
}

#[repr(C)]
struct PcapPkthdr {
    ts_sec: c_long,
    ts_usec: c_long,
    caplen: c_uint,
    len: c_uint,
}

#[repr(C)]
struct BpfProgram {
    bf_len: c_uint,
    bf_insns: *mut std::ffi::c_void,
}

const PCAP_IF_LOOPBACK: c_uint = 0x1;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

struct Pcap {
    _lib: Library,
    findalldevs: unsafe extern "C" fn(*mut *mut PcapIf, *mut c_char) -> c_int,
    freealldevs: unsafe extern "C" fn(*mut PcapIf),
    open_live: unsafe extern "C" fn(*const c_char, c_int, c_int, c_int, *mut c_char) -> PcapT,
    next_ex: unsafe extern "C" fn(PcapT, *mut *mut PcapPkthdr, *mut *const u8) -> c_int,
    datalink: unsafe extern "C" fn(PcapT) -> c_int,
    compile: Option<unsafe extern "C" fn(PcapT, *mut BpfProgram, *const c_char, c_int, u32) -> c_int>,
    setfilter: Option<unsafe extern "C" fn(PcapT, *mut BpfProgram) -> c_int>,
    freecode: Option<unsafe extern "C" fn(*mut BpfProgram)>,
}

unsafe impl Send for Pcap {}
unsafe impl Sync for Pcap {}

/// Why capture could not start, in words for the player.
#[derive(Debug, Clone, serde::Serialize)]
pub enum Problem {
    /// Npcap is not installed.
    NoNpcap,
    /// Npcap is there but gave no network adapter (installed "for administrators only").
    NoDevices(String),
}

#[cfg(windows)]
unsafe fn load_lib() -> Result<Library, String> {
    use libloading::os::windows::{Library as WinLib, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32};
    // System32 as Windows knows it (not %SystemRoot%, which anything can set).
    let mut buf = [0u16; 512];
    let n = windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) as usize;
    if n == 0 || n >= buf.len() {
        return Err("no System32".into());
    }
    let system = std::path::PathBuf::from(String::from_utf16_lossy(&buf[..n]));
    let flags = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32;
    // Npcap's own folder first (its normal install), then System32 (its
    // WinPcap-compatible mode). Never the usual search: it goes on into PATH.
    let mut errors = Vec::new();
    for path in [system.join("Npcap").join("wpcap.dll"), system.join("wpcap.dll")] {
        match WinLib::load_with_flags(&path, flags) {
            Ok(l) => return Ok(l.into()),
            Err(e) => errors.push(format!("{}: {e}", path.display())),
        }
    }
    Err(errors.join("; "))
}

#[cfg(not(windows))]
unsafe fn load_lib() -> Result<Library, String> {
    for name in ["libpcap.so.1", "libpcap.so.0.8", "libpcap.so", "libpcap.dylib"] {
        if let Ok(l) = Library::new(name) {
            return Ok(l);
        }
    }
    Err("libpcap not found".into())
}

impl Pcap {
    fn load() -> Result<Self, String> {
        unsafe {
            let lib = load_lib()?;
            macro_rules! sym {
                ($n:literal) => {
                    *lib.get($n).map_err(|e| format!("{}: {e}", String::from_utf8_lossy($n)))?
                };
            }
            macro_rules! opt {
                ($n:literal) => {
                    lib.get($n).ok().map(|s| *s)
                };
            }
            Ok(Pcap {
                findalldevs: sym!(b"pcap_findalldevs"),
                freealldevs: sym!(b"pcap_freealldevs"),
                open_live: sym!(b"pcap_open_live"),
                next_ex: sym!(b"pcap_next_ex"),
                datalink: sym!(b"pcap_datalink"),
                compile: opt!(b"pcap_compile"),
                setfilter: opt!(b"pcap_setfilter"),
                freecode: opt!(b"pcap_freecode"),
                _lib: lib,
            })
        }
    }

    /// The adapters with an address of their own (the ones traffic comes in on).
    fn devices(&self) -> Result<Vec<(String, String)>, String> {
        let mut all: *mut PcapIf = ptr::null_mut();
        let mut err = [0u8; 256];
        let ret = unsafe { (self.findalldevs)(&mut all, err.as_mut_ptr() as *mut c_char) };
        if ret != 0 {
            return Err(unsafe { CStr::from_ptr(err.as_ptr() as *const c_char) }.to_string_lossy().into_owned());
        }
        let mut out = Vec::new();
        let mut d = all;
        while !d.is_null() {
            let dev = unsafe { &*d };
            let name = if dev.name.is_null() { String::new() } else { unsafe { CStr::from_ptr(dev.name) }.to_string_lossy().into_owned() };
            let desc = if dev.description.is_null() { String::new() } else { unsafe { CStr::from_ptr(dev.description) }.to_string_lossy().into_owned() };
            let loopback = dev.flags & PCAP_IF_LOOPBACK != 0 || name.to_lowercase().contains("loopback");
            if !dev.addresses.is_null() && !loopback && !name.is_empty() {
                out.push((name, desc));
            }
            d = dev.next;
        }
        if !all.is_null() {
            unsafe { (self.freealldevs)(all) };
        }
        Ok(out)
    }

    fn set_filter(&self, h: PcapT, text: &str) -> bool {
        let (Some(compile), Some(setfilter), Some(freecode)) = (self.compile, self.setfilter, self.freecode) else { return false };
        let Ok(c) = CString::new(text) else { return false };
        let mut prog = BpfProgram { bf_len: 0, bf_insns: ptr::null_mut() };
        unsafe {
            if compile(h, &mut prog, c.as_ptr(), 1, 0xffff_ffff) != 0 {
                return false;
            }
            let ok = setfilter(h, &mut prog) == 0;
            freecode(&mut prog);
            ok
        }
    }
}

/// Starts one reading thread per network adapter; segments go to `tx`.
/// Returns the adapters' names, or why nothing could start.
pub fn start(tx: SyncSender<Segment>) -> Result<Vec<String>, Problem> {
    let pcap = Arc::new(Pcap::load().map_err(|e| {
        tracing::warn!("pcap: {e}");
        Problem::NoNpcap
    })?);
    let devices = pcap.devices().map_err(Problem::NoDevices)?;
    if devices.is_empty() {
        return Err(Problem::NoDevices("nenhum adaptador".into()));
    }
    let mut names = Vec::new();
    for (name, desc) in devices {
        let label = if desc.is_empty() { name.clone() } else { desc.clone() };
        names.push(label.clone());
        let pcap = pcap.clone();
        let tx = tx.clone();
        std::thread::Builder::new()
            .name(format!("captura {label}"))
            .spawn(move || read_device(&pcap, &name, &label, tx))
            .ok();
    }
    Ok(names)
}

fn read_device(pcap: &Pcap, name: &str, label: &str, tx: SyncSender<Segment>) {
    let Ok(c_name) = CString::new(name) else { return };
    let mut err = [0u8; 256];
    // Not promiscuous: only this computer's own traffic.
    let h = unsafe { (pcap.open_live)(c_name.as_ptr(), 65535, 0, 100, err.as_mut_ptr() as *mut c_char) };
    if h.is_null() {
        tracing::warn!("{label}: {}", unsafe { CStr::from_ptr(err.as_ptr() as *const c_char) }.to_string_lossy());
        return;
    }
    let link = unsafe { (pcap.datalink)(h) };
    // IPv4 TCP but the web's ports, which the game never uses.
    let plain = "ip and tcp and not port 80 and not port 443";
    let vlan = format!("({plain}) or (vlan and (({plain}) or (vlan and {plain})))");
    if !pcap.set_filter(h, &vlan) {
        pcap.set_filter(h, plain);
    }
    tracing::info!("capturando em {label} (link {link})");
    loop {
        let mut hdr: *mut PcapPkthdr = ptr::null_mut();
        let mut data: *const u8 = ptr::null();
        let ret = unsafe { (pcap.next_ex)(h, &mut hdr, &mut data) };
        if ret == 0 {
            continue; // timeout, nothing came
        }
        if ret < 0 {
            tracing::warn!("{label}: leitura parou ({ret})");
            return;
        }
        let hdr = unsafe { &*hdr };
        let frame = unsafe { std::slice::from_raw_parts(data, hdr.caplen as usize) };
        let ts = hdr.ts_sec as i64 * 1000 + hdr.ts_usec as i64 / 1000;
        let at = if (1_000_000_000_000..2_000_000_000_000).contains(&ts) { ts } else { now_ms() };
        if let Some(seg) = tcp_payload(frame, link, at) {
            if tx.try_send(seg).is_err() {
                // The reader is behind: this one is lost (tcp_order reports the hole).
            }
        }
    }
}

fn link_header_len(link: c_int, f: &[u8]) -> Option<usize> {
    let be16 = |at: usize| f.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]));
    match link {
        1 => {
            let mut at = 12;
            for _ in 0..2 {
                match be16(at)? {
                    0x8100 | 0x88A8 => at += 4,
                    _ => break,
                }
            }
            (be16(at)? == 0x0800).then_some(at + 2)
        }
        0 => (f.get(..4)? == [2, 0, 0, 0]).then_some(4),
        12 | 14 | 101 | 228 => Some(0),
        113 => (be16(14)? == 0x0800).then_some(16),
        276 => (be16(0)? == 0x0800).then_some(20),
        _ => None,
    }
}

pub fn tcp_payload(f: &[u8], link: c_int, at: i64) -> Option<Segment> {
    let ip = link_header_len(link, f).filter(|&a| f.get(a).is_some_and(|b| b >> 4 == 4))?;
    let iph = f.get(ip..ip + 20)?;
    if iph[9] != 6 {
        return None;
    }
    let ihl = (iph[0] & 0x0F) as usize * 4;
    let tcp = ip + ihl;
    let th = f.get(tcp..tcp + 20)?;
    let total = u16::from_be_bytes([iph[2], iph[3]]) as usize;
    // Ethernet pads short frames: the payload ends where IP says.
    let end = if total >= ihl + 20 && ip + total <= f.len() { ip + total } else { f.len() };
    let start = tcp + (th[12] >> 4) as usize * 4;
    if start >= end {
        return None;
    }
    Some(Segment {
        src_ip: Ipv4Addr::new(iph[12], iph[13], iph[14], iph[15]),
        dst_ip: Ipv4Addr::new(iph[16], iph[17], iph[18], iph[19]),
        src_port: u16::from_be_bytes([th[0], th[1]]),
        dst_port: u16::from_be_bytes([th[2], th[3]]),
        seq: u32::from_be_bytes([th[4], th[5], th[6], th[7]]),
        data: f[start..end].to_vec(),
        at_ms: at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ethernet_tcp() {
        let mut f = vec![0u8; 12];
        f.extend_from_slice(&[0x08, 0x00]);
        f.extend_from_slice(&[0x45, 0, 0, 42, 0, 0, 0, 0, 64, 6, 0, 0, 1, 2, 3, 4, 10, 0, 0, 2]);
        f.extend_from_slice(&[0x34, 0x10, 0xC7, 0x38, 0, 0, 0, 7, 0, 0, 0, 0, 0x50, 0x18, 0, 0, 0, 0, 0, 0]);
        f.extend_from_slice(b"hi");
        f.extend_from_slice(&[0xAA; 6]); // padding
        let s = tcp_payload(&f, 1, 5).unwrap();
        assert_eq!((s.src_port, s.dst_port, s.seq), (13328, 51000, 7));
        assert_eq!(s.data, b"hi");
    }
}
