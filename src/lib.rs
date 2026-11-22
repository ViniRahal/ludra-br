//! Ludra BR's core, with no window in it: the capture, the game's stream and
//! the records read from it. GPL-3.0 (LICENSE).
pub mod capture;
pub mod flows;
pub mod framing;
pub mod history;
pub mod hotkeys;
pub mod meter;
pub mod parser;
pub mod recfiles;
pub mod tcp_order;
pub mod tunnel;
