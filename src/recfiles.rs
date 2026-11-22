//! Which of Game Bar's videos belong to a recording, and where they go.
//! No window and no Windows call in here, so the rules are tested anywhere
//! (`cargo test --no-default-features`); the moving itself is in record.rs.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Game Bar names the file when it starts and may finish it a few seconds
/// after the stop key, so the window around the recording is a little wider
/// than the clicks. Narrow enough that the next pull's video is not taken.
pub const SLACK_BEFORE: Duration = Duration::from_secs(5);
pub const SLACK_AFTER: Duration = Duration::from_secs(15);

/// One file found in Captures.
#[derive(Clone, Debug)]
pub struct Seen {
    pub name: String,
    /// When the file was made (NTFS keeps it). None where the system has none.
    pub created: Option<SystemTime>,
    pub modified: SystemTime,
}

pub fn is_video(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".mp4")
}

/// True when this video was made by the recording that ran from `since` to
/// `until`. An older video only touched (played, renamed) during the fight
/// keeps its old creation time and is left alone. `next_start` is when a
/// newer recording started, if one did: a file made after it is that one's,
/// even inside this recording's slack (a quick re-pull, a stop then a start).
pub fn is_from(f: &Seen, since: SystemTime, until: SystemTime, next_start: Option<SystemTime>) -> bool {
    if !is_video(&f.name) {
        return false;
    }
    let (lo, hi) = window(since, until, next_start);
    let made = f.created.unwrap_or(f.modified);
    made >= lo && made <= hi && f.modified >= lo
}

/// The times a recording's video may have been made in.
fn window(since: SystemTime, until: SystemTime, next_start: Option<SystemTime>) -> (SystemTime, SystemTime) {
    let lo = since.checked_sub(SLACK_BEFORE).unwrap_or(since);
    let mut hi = until + SLACK_AFTER;
    if let Some(n) = next_start.filter(|n| *n > until) {
        // A second before the next start: Game Bar makes the file a little
        // after the key, never before it.
        hi = hi.min(n.checked_sub(Duration::from_secs(1)).unwrap_or(n).max(until));
    }
    (lo, hi)
}

/// One recording makes one video: of the files that fit, the one made
/// closest to the start. The others (if any) are never touched.
pub fn pick<'a>(found: &'a [Seen], since: SystemTime) -> Option<&'a Seen> {
    let gap = |f: &Seen| {
        let made = f.created.unwrap_or(f.modified);
        made.duration_since(since).or_else(|_| since.duration_since(made)).unwrap_or(Duration::MAX)
    };
    found.iter().filter(|f| is_video(&f.name)).min_by_key(|f| gap(f))
}

/// Why a file could not be moved or written, in plain words for the player
/// (never the system's code). None: nothing better to say than "it failed".
pub fn why(kind: std::io::ErrorKind, code: Option<i32>) -> Option<&'static str> {
    use std::io::ErrorKind as K;
    // ERROR_DISK_FULL 112 and ERROR_HANDLE_DISK_FULL 39 on Windows, ENOSPC 28.
    if kind == K::StorageFull || kind == K::QuotaExceeded || matches!(code, Some(112) | Some(39)) || (!cfg!(windows) && code == Some(28)) {
        return Some("disco cheio");
    }
    match kind {
        K::PermissionDenied | K::ReadOnlyFilesystem => Some("sem permissão na pasta"),
        K::NotFound => Some("a pasta não existe mais (pendrive ou HD desligado?)"),
        _ => None,
    }
}

/// ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION: someone (Game Bar, a
/// player opening it) still has the file. The only error worth trying again.
pub fn is_busy(code: Option<i32>) -> bool {
    cfg!(windows) && matches!(code, Some(32) | Some(33))
}

/// How a folder is named to the player: Game Bar's usual one as Windows
/// shows it, any other by its full path.
pub fn folder_label(dir: &Path) -> String {
    let s = dir.to_string_lossy().replace('/', "\\");
    let low = s.trim_end_matches('\\').to_lowercase();
    if low.ends_with("\\videos\\captures") || low.ends_with("\\vídeos\\captures") {
        "Vídeos\\Captures".to_string()
    } else {
        s
    }
}

/// A file or folder name the user (or the time) gave, made safe for Windows:
/// no slashes, no ".." to climb out, none of the characters it refuses.
pub fn safe_part(s: &str) -> String {
    let out: String = s.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '-' } else { c }).collect();
    let out = out.trim().trim_end_matches('.').trim().to_string();
    if out.is_empty() || out.chars().all(|c| c == '.') {
        String::new()
    } else {
        out
    }
}

/// The folder the video goes to: the chosen one, or under it today's folder.
pub fn target_dir(base: &Path, day: &str) -> PathBuf {
    let d = safe_part(day);
    if d.is_empty() {
        base.to_path_buf()
    } else {
        base.join(d)
    }
}

/// A name in `dir` that is not taken: "x.mp4", then "x (2).mp4", ...
/// Nothing already there is ever overwritten.
pub fn unique_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2..1000 {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !exists(&p) {
            return p;
        }
    }
    dir.join(format!("{stem} ({}){ext}", std::process::id()))
}

/// The fight's log takes the video's name, so the two sit side by side.
pub fn log_name_for(video: &str) -> String {
    let stem = match video.rfind('.') {
        Some(i) if i > 0 => &video[..i],
        _ => video,
    };
    format!("{stem} - registro da luta.txt")
}

/// Same folder? Windows paths do not care about case or a trailing slash.
pub fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn at(s: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_700_000_000 + s)
    }
    fn seen(name: &str, created: Option<u64>, modified: u64) -> Seen {
        Seen { name: name.into(), created: created.map(at), modified: at(modified) }
    }

    #[test]
    fn picks_only_this_recordings_video() {
        let (since, until) = (at(100), at(400));
        let is_from = |f: &Seen, since, until| is_from(f, since, until, None);
        assert!(is_from(&seen("AION2 a.mp4", Some(101), 405), since, until));
        assert!(is_from(&seen("AION2 b.MP4", Some(98), 402), since, until), "named just before the click");
        // An old video opened or touched during the fight.
        assert!(!is_from(&seen("old.mp4", Some(10), 300), since, until));
        // The next pull's video, started well after this one stopped.
        assert!(!is_from(&seen("next.mp4", Some(460), 470), since, until));
        assert!(!is_from(&seen("log.txt", Some(101), 405), since, until));
        // No creation time: the last write decides.
        assert!(is_from(&seen("x.mp4", None, 405), since, until));
        assert!(!is_from(&seen("x.mp4", None, 50), since, until));
    }

    #[test]
    fn next_pull_is_not_taken() {
        // Stopped at 400, the next pull (or a quick "Gravar agora") at 409:
        // its file, made inside this one's 15 s slack, is not this one's.
        let (since, until, next) = (at(100), at(400), Some(at(409)));
        assert!(!is_from(&seen("next.mp4", Some(410), 411), since, until, next));
        assert!(!is_from(&seen("next.mp4", Some(409), 411), since, until, next), "right at the key");
        assert!(is_from(&seen("late.mp4", Some(405), 406), since, until, next), "between the stop and the next key");
        assert!(is_from(&seen("this.mp4", Some(101), 405), since, until, next), "this one still is");
        // Without the next start the slack would have taken it.
        assert!(is_from(&seen("next.mp4", Some(410), 411), since, until, None));
        // A start before the stop is this recording's own: no cap.
        assert!(is_from(&seen("this.mp4", Some(101), 405), since, until, Some(at(100))));
        assert!(is_from(&seen("late.mp4", Some(410), 411), since, until, Some(at(100))));
        // Next start right at the stop: the cap never goes before the stop.
        assert!(is_from(&seen("this.mp4", Some(101), 400), since, until, Some(at(400))));
    }

    #[test]
    fn one_video_per_recording() {
        let since = at(100);
        let found = [seen("b.mp4", Some(112), 300), seen("a.mp4", Some(101), 300), seen("c.mp4", Some(97), 300)];
        assert_eq!(pick(&found, since).map(|f| f.name.as_str()), Some("a.mp4"));
        assert!(pick(&[], since).is_none());
        assert!(pick(&[seen("x.txt", Some(100), 100)], since).is_none());
    }

    #[test]
    fn plain_reasons() {
        use std::io::ErrorKind as K;
        assert_eq!(why(K::PermissionDenied, Some(5)), Some("sem permissão na pasta"));
        assert_eq!(why(K::Other, Some(112)), Some("disco cheio"));
        assert_eq!(why(K::StorageFull, None), Some("disco cheio"));
        assert_eq!(why(K::NotFound, Some(3)), Some("a pasta não existe mais (pendrive ou HD desligado?)"));
        assert_eq!(why(K::Other, Some(1)), None);
        assert!(!is_busy(Some(5)));
        assert_eq!(folder_label(Path::new("C:\\Users\\a\\Videos\\Captures")), "Vídeos\\Captures");
        assert_eq!(folder_label(Path::new("D:\\Zezinho 1")), "D:\\Zezinho 1");
    }

    #[test]
    fn names_are_safe() {
        assert_eq!(safe_part("2026-11-22"), "2026-11-22");
        assert_eq!(safe_part("..\\..\\Windows"), "..-..-Windows");
        assert_eq!(safe_part(".."), "");
        assert_eq!(safe_part("a/b:c"), "a-b-c");
        assert_eq!(target_dir(Path::new("D:\\Zezinho"), ""), PathBuf::from("D:\\Zezinho"));
        assert_eq!(target_dir(Path::new("D:\\Zezinho"), "2026-11-22"), Path::new("D:\\Zezinho").join("2026-11-22"));
        assert_eq!(target_dir(Path::new("D:\\Zezinho"), ".."), PathBuf::from("D:\\Zezinho"));
    }

    #[test]
    fn never_overwrites() {
        let dir = Path::new("dir");
        let taken = [dir.join("v.mp4"), dir.join("v (2).mp4")];
        assert_eq!(unique_path(dir, "w.mp4", |p| taken.contains(&p.to_path_buf())), dir.join("w.mp4"));
        assert_eq!(unique_path(dir, "v.mp4", |p| taken.contains(&p.to_path_buf())), dir.join("v (3).mp4"));
        assert_eq!(log_name_for("AION2 2026-11-22 15-08-49.mp4"), "AION2 2026-11-22 15-08-49 - registro da luta.txt");
    }

    #[test]
    fn same_folder_ignores_case() {
        assert!(same_dir(Path::new("C:\\Users\\a\\Videos\\Captures\\"), Path::new("c:/users/a/videos/captures")));
        assert!(!same_dir(Path::new("C:\\a"), Path::new("C:\\b")));
    }
}
