// The program's own recorder: the screen the game is on, straight into an
// .mp4 in the player's folder, with the sound of the PC. It does not depend
// on the Xbox Game Bar, whose key (Win+Alt+R) Windows does not pass on when
// the game runs as administrator, and which some PCs have turned off.
//
// The picture: Windows' screen capture (the same one OBS uses for a display),
// through the windows-capture crate (MIT), encoded to H.264 by Windows'
// own encoder (on the graphics card when there is one). The sound: what the
// PC plays (WASAPI loopback), made 16-bit stereo, with silence filled in
// while nothing plays so it stays in step with the picture.

use serde::Serialize;

#[derive(Serialize, Default, Clone)]
pub struct Done {
    pub video: Option<String>,
    pub bytes: u64,
    pub problem: Option<String>,
}

/// How a recording is made: frames a second, the bitrate, and whether the
/// PC's sound goes in.
#[derive(Clone, Copy)]
pub struct Opts {
    pub fps: u32,
    pub bitrate: u32,
    pub sound: bool,
}

#[cfg(windows)]
pub use win::{start, stop};

#[cfg(not(windows))]
pub fn start(_path: &std::path::Path, _o: Opts) -> Result<(), String> {
    Err("Só funciona no Windows.".into())
}
#[cfg(not(windows))]
pub fn stop() -> Done {
    Done::default()
}

#[cfg(windows)]
mod win {
    use super::{Done, Opts};
    use parking_lot::Mutex;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Instant;
    use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
    use windows_capture::encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings};

    type Err = Box<dyn std::error::Error + Send + Sync>;

    /// What the capture and the sound share.
    struct Shared {
        encoder: Mutex<Option<VideoEncoder>>,
        /// When the first picture went in: the sound's clock starts there.
        first: Mutex<Option<Instant>>,
        /// The encoder failed: what it said.
        failed: Mutex<Option<String>>,
        sound: bool,
    }

    struct Rec {
        shared: Arc<Shared>,
        min_gap: i64, // 100 ns units between two frames kept
        last_ts: Option<i64>,
    }

    impl GraphicsCaptureApiHandler for Rec {
        type Flags = (Arc<Shared>, u32);
        type Error = Err;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            let (shared, fps) = ctx.flags;
            Ok(Self { shared, min_gap: 10_000_000 / fps.max(1) as i64 - 20_000, last_ts: None })
        }

        fn on_frame_arrived(&mut self, frame: &mut Frame, _c: InternalCaptureControl) -> Result<(), Self::Error> {
            // Fewer frames than the screen gives when the player chose 30.
            let ts = frame.timestamp()?.Duration;
            if self.last_ts.is_some_and(|l| ts - l < self.min_gap) {
                return Ok(());
            }
            self.last_ts = Some(ts);
            let mut enc = self.shared.encoder.lock();
            let Some(e) = enc.as_mut() else { return Ok(()) };
            if let Err(err) = e.send_frame(frame) {
                *self.shared.failed.lock() = Some(err.to_string());
                *enc = None;
                return Ok(());
            }
            drop(enc);
            let mut first = self.shared.first.lock();
            if first.is_none() {
                *first = Some(Instant::now());
            }
            Ok(())
        }

        fn on_closed(&mut self) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    struct Running {
        path: PathBuf,
        shared: Arc<Shared>,
        control: CaptureControl<Rec, Err>,
        sound_stop: Arc<AtomicBool>,
        sound: Option<std::thread::JoinHandle<()>>,
    }

    static NOW: Mutex<Option<Running>> = Mutex::new(None);

    /// The monitor the game is on (else the main one).
    fn game_monitor() -> Monitor {
        use windows_sys::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY};
        if let Some(h) = crate::record::game_hwnd() {
            let m = unsafe { MonitorFromWindow(h as _, MONITOR_DEFAULTTOPRIMARY) };
            if !m.is_null() {
                return Monitor::from_raw_hmonitor(m as _);
            }
        }
        Monitor::primary().unwrap_or_else(|_| Monitor::from_raw_hmonitor(std::ptr::null_mut()))
    }

    pub fn start(path: &Path, o: Opts) -> Result<(), String> {
        let mut now = NOW.lock();
        if now.is_some() {
            return Ok(());
        }
        let monitor = game_monitor();
        let (w, h) = (monitor.width().map_err(|e| e.to_string())?, monitor.height().map_err(|e| e.to_string())?);
        // The sound's format comes first: the encoder is made for it.
        let sound = if o.sound { audio::Loopback::open().ok() } else { None };
        let (rate, channels) = sound.as_ref().map(|s| (s.rate, 2)).unwrap_or((48_000, 2));
        let audio = AudioSettingsBuilder::new().sample_rate(rate).channel_count(channels).bit_per_sample(16).bitrate(160_000).disabled(sound.is_none());
        let video = VideoSettingsBuilder::new(w & !1, h & !1).sub_type(VideoSettingsSubType::H264).bitrate(o.bitrate).frame_rate(o.fps);
        let encoder = VideoEncoder::new(video, audio, ContainerSettingsBuilder::default(), path).map_err(|e| format!("Não consegui criar o vídeo: {e}"))?;
        let shared = Arc::new(Shared { encoder: Mutex::new(Some(encoder)), first: Mutex::new(None), failed: Mutex::new(None), sound: sound.is_some() });
        // No yellow frame around the screen, where Windows lets us say so.
        let border = if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false) { DrawBorderSettings::WithoutBorder } else { DrawBorderSettings::Default };
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::Default,
            border,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            (shared.clone(), o.fps),
        );
        let control = Rec::start_free_threaded(settings).map_err(|e| format!("O Windows não deixou gravar a tela: {e}"))?;
        let sound_stop = Arc::new(AtomicBool::new(false));
        let handle = sound.map(|s| {
            let (sh, st) = (shared.clone(), sound_stop.clone());
            std::thread::spawn(move || s.run(sh, st))
        });
        *now = Some(Running { path: path.to_path_buf(), shared, control, sound_stop, sound: handle });
        Ok(())
    }

    pub fn stop() -> Done {
        let Some(r) = NOW.lock().take() else { return Done::default() };
        r.sound_stop.store(true, Ordering::Relaxed);
        if let Some(h) = r.sound {
            let _ = h.join();
        }
        let _ = r.control.stop();
        let mut out = Done::default();
        let enc = r.shared.encoder.lock().take();
        match enc {
            Some(e) => {
                if let Err(e) = e.finish() {
                    out.problem = Some(format!("O vídeo pode ter ficado incompleto: {e}"));
                }
            }
            None => out.problem = Some(format!("A gravação parou no meio: {}", r.shared.failed.lock().clone().unwrap_or_default())),
        }
        if let Ok(m) = std::fs::metadata(&r.path) {
            out.bytes = m.len();
            if m.len() > 0 {
                out.video = Some(r.path.to_string_lossy().into());
            }
        }
        if out.video.is_none() && r.shared.first.lock().is_none() {
            out.problem = Some("Nenhuma imagem chegou da tela. Se o jogo estiver em tela cheia exclusiva, use o modo janela sem borda.".into());
        }
        out
    }

    mod audio {
        use super::Shared;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use std::time::{Duration, Instant};
        use windows::Win32::Media::Audio::{
            eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX,
        };
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

        #[derive(Clone, Copy)]
        enum Kind {
            F32,
            I16,
            I24,
            I32,
        }

        pub struct Loopback {
            pub rate: u32,
            channels: usize,
            kind: Kind,
            block: usize,
        }

        impl Loopback {
            /// The PC's playback format, read once to set up the encoder.
            pub fn open() -> windows::core::Result<Self> {
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                    let (client, fmt) = Self::client()?;
                    let f = &*fmt;
                    let me = Self::from_format(f);
                    CoTaskMemFree(Some(fmt as *const _ as _));
                    drop(client);
                    Ok(me)
                }
            }

            unsafe fn client() -> windows::core::Result<(IAudioClient, *mut WAVEFORMATEX)> {
                unsafe {
                    let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                    let dev = en.GetDefaultAudioEndpoint(eRender, eConsole)?;
                    let client: IAudioClient = dev.Activate(CLSCTX_ALL, None)?;
                    let fmt = client.GetMixFormat()?;
                    Ok((client, fmt))
                }
            }

            fn from_format(f: &WAVEFORMATEX) -> Self {
                let tag = f.wFormatTag;
                let bits = f.wBitsPerSample;
                // WAVE_FORMAT_EXTENSIBLE: the real type is in SubFormat's first
                // four bytes (1 = PCM, 3 = float), 24 bytes in.
                let sub = if tag == 0xFFFE {
                    unsafe { std::ptr::read_unaligned((f as *const WAVEFORMATEX as *const u8).add(24) as *const u32) }
                } else {
                    tag as u32
                };
                let kind = match (sub, bits) {
                    (3, _) => Kind::F32,
                    (_, 16) => Kind::I16,
                    (_, 24) => Kind::I24,
                    _ => Kind::I32,
                };
                Self { rate: f.nSamplesPerSec, channels: f.nChannels.max(1) as usize, kind, block: f.nBlockAlign.max(1) as usize }
            }

            /// One sample of one channel, as 16 bits.
            fn sample(&self, p: &[u8]) -> i16 {
                match self.kind {
                    Kind::F32 => (f32::from_le_bytes([p[0], p[1], p[2], p[3]]).clamp(-1.0, 1.0) * 32767.0) as i16,
                    Kind::I16 => i16::from_le_bytes([p[0], p[1]]),
                    Kind::I24 => i16::from_le_bytes([p[1], p[2]]),
                    Kind::I32 => i16::from_le_bytes([p[2], p[3]]),
                }
            }

            /// Interleaved frames to 16-bit stereo (a mono PC: both sides the
            /// same; 5.1 and more: the front left and right).
            fn convert(&self, data: &[u8], frames: usize, out: &mut Vec<u8>) {
                let size = self.block / self.channels;
                for i in 0..frames {
                    let f = &data[i * self.block..(i + 1) * self.block];
                    let l = self.sample(&f[0..size]);
                    let r = if self.channels > 1 { self.sample(&f[size..2 * size]) } else { l };
                    out.extend_from_slice(&l.to_le_bytes());
                    out.extend_from_slice(&r.to_le_bytes());
                }
            }

            pub fn run(self, shared: Arc<Shared>, stop: Arc<AtomicBool>) {
                let _ = unsafe { self.run_inner(&shared, &stop) };
            }

            unsafe fn run_inner(&self, shared: &Shared, stop: &AtomicBool) -> windows::core::Result<()> {
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                    let (client, fmt) = Self::client()?;
                    client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt, None)?;
                    CoTaskMemFree(Some(fmt as *const _ as _));
                    let cap: IAudioCaptureClient = client.GetService()?;
                    // The sound starts with the first picture, so both begin at 0.
                    while shared.first.lock().is_none() {
                        if stop.load(Ordering::Relaxed) {
                            return Ok(());
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    client.Start()?;
                    let begin = Instant::now();
                    let mut sent: u64 = 0;
                    let mut buf: Vec<u8> = Vec::new();
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(10));
                        buf.clear();
                        loop {
                            let n = cap.GetNextPacketSize()?;
                            if n == 0 {
                                break;
                            }
                            let mut data = std::ptr::null_mut();
                            let mut frames = 0u32;
                            let mut flags = 0u32;
                            cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                            let f = frames as usize;
                            if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                                buf.resize(buf.len() + f * 4, 0);
                            } else {
                                let slice = std::slice::from_raw_parts(data, f * self.block);
                                self.convert(slice, f, &mut buf);
                            }
                            cap.ReleaseBuffer(frames)?;
                        }
                        // Windows sends nothing while the PC is silent: fill
                        // the gap, or the sound would run ahead of the picture.
                        let have = sent + (buf.len() / 4) as u64;
                        let due = (begin.elapsed().as_secs_f64() * self.rate as f64) as u64;
                        let slack = self.rate as u64 / 10;
                        if due > have + slack {
                            buf.resize(buf.len() + ((due - have) as usize) * 4, 0);
                        }
                        if buf.is_empty() {
                            continue;
                        }
                        sent += (buf.len() / 4) as u64;
                        let mut enc = shared.encoder.lock();
                        match enc.as_mut() {
                            Some(e) if shared.sound => {
                                if e.send_audio_buffer(&buf, 0).is_err() {
                                    break;
                                }
                            }
                            _ => break,
                        }
                    }
                    let _ = client.Stop();
                    Ok(())
                }
            }
        }
    }
}
