//! The chat subsystem — BranchLab's layer between the OpenCode engine and the UI.
//!
//! This owns the normalized conversation model, a persistent SQLite cache
//! (independent of the engine, so the transcript survives restarts and engine
//! session compaction/clear), a formal turn lifecycle, and the delta events the
//! frontend renders. The engine transport (ACP) lives under `crate::engine`.
//!
//! Built incrementally; submodules are wired into `ChatManager` as they land.

pub mod assembler;
pub mod commands;
pub mod events;
pub mod manager;
pub mod model;
pub mod store;
