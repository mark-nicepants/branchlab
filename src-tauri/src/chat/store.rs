//! The persistent chat cache (SQLite via rusqlite).
//!
//! BranchLab owns this store outright — it is the display source of truth,
//! decoupled from OpenCode's own session storage. That is what lets the
//! transcript survive app restarts and engine session compaction/clear, load
//! instantly on workspace switch (no re-fetch), and span multiple engine
//! sessions under one conversation.
//!
//! `ChatDb` wraps a single `rusqlite::Connection`; SQLite is single-threaded, so
//! the manager runs it behind a store-actor thread (see `manager.rs`) — never
//! shared across threads. Time and id generation are the caller's job so this
//! layer stays deterministic and unit-testable.
//!
//! Simplification vs. a fully-normalized schema: each entry is one row with its
//! blocks inline as JSON (`data`). Ordering/pagination use the `seq` rowid; the
//! `kind`/`status` columns exist only so we can query active turns cheaply
//! (e.g. failing interrupted turns on startup). If per-block lazy loading is
//! ever needed for pathologically long turns, add a `blocks` table then.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::chat::model::{Conversation, EngineSession, Entry, SessionReason, TurnStatus};

const SCHEMA_VERSION: i64 = 1;

pub struct ChatDb {
    conn: Connection,
}

impl ChatDb {
    /// Open (creating if needed) the chat database at `path` and run migrations.
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    /// In-memory database, for tests that don't need durability.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        // WAL keeps reads (snapshots) from blocking the store actor's writes.
        conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS conversations (
               id TEXT PRIMARY KEY,
               workspace_id TEXT NOT NULL UNIQUE,
               title TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               active_engine_session TEXT
             );
             CREATE TABLE IF NOT EXISTS engine_sessions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               conversation_id TEXT NOT NULL REFERENCES conversations(id),
               acp_session_id TEXT NOT NULL,
               engine TEXT NOT NULL,
               reason TEXT NOT NULL,
               started_at INTEGER NOT NULL,
               active INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_es_conv ON engine_sessions(conversation_id);
             CREATE TABLE IF NOT EXISTS entries (
               seq INTEGER PRIMARY KEY AUTOINCREMENT,
               conversation_id TEXT NOT NULL REFERENCES conversations(id),
               entry_id TEXT NOT NULL UNIQUE,
               kind TEXT NOT NULL,
               status TEXT,
               origin TEXT,
               created_at INTEGER NOT NULL,
               data TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_entries_conv_seq ON entries(conversation_id, seq);",
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(Self { conn })
    }

    // ── Conversations ──────────────────────────────────────────────────────

    pub fn get_conversation(&self, workspace_id: &str) -> Result<Option<Conversation>, String> {
        self.conn
            .query_row(
                "SELECT id, workspace_id, title, created_at, active_engine_session
                 FROM conversations WHERE workspace_id = ?1",
                params![workspace_id],
                |r| {
                    Ok(Conversation {
                        id: r.get(0)?,
                        workspace_id: r.get(1)?,
                        title: r.get(2)?,
                        created_at: r.get(3)?,
                        active_engine_session: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn create_conversation(&self, c: &Conversation) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO conversations (id, workspace_id, title, created_at, updated_at, active_engine_session)
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                params![c.id, c.workspace_id, c.title, c.created_at, c.active_engine_session],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn set_conversation_title(&self, conversation_id: &str, title: &str) -> Result<(), String> {
        self.conn
            .execute("UPDATE conversations SET title = ?2 WHERE id = ?1", params![conversation_id, title])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    // ── Engine sessions ────────────────────────────────────────────────────

    /// Open a new engine session under a conversation, mark it active (and the
    /// prior one inactive), and point the conversation at it. Keeps all entries.
    pub fn add_engine_session(
        &self,
        conversation_id: &str,
        acp_session_id: &str,
        engine: &str,
        reason: SessionReason,
        started_at: i64,
    ) -> Result<EngineSession, String> {
        self.conn
            .execute("UPDATE engine_sessions SET active = 0 WHERE conversation_id = ?1", params![conversation_id])
            .map_err(|e| e.to_string())?;
        let reason_s = reason_str(reason);
        self.conn
            .execute(
                "INSERT INTO engine_sessions (conversation_id, acp_session_id, engine, reason, started_at, active)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                params![conversation_id, acp_session_id, engine, reason_s, started_at],
            )
            .map_err(|e| e.to_string())?;
        let id = self.conn.last_insert_rowid();
        self.conn
            .execute(
                "UPDATE conversations SET active_engine_session = ?2 WHERE id = ?1",
                params![conversation_id, acp_session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(EngineSession {
            id,
            conversation_id: conversation_id.to_string(),
            acp_session_id: acp_session_id.to_string(),
            engine: engine.to_string(),
            reason,
            started_at,
            active: true,
        })
    }

    pub fn list_engine_sessions(&self, conversation_id: &str) -> Result<Vec<EngineSession>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, conversation_id, acp_session_id, engine, reason, started_at, active
                 FROM engine_sessions WHERE conversation_id = ?1 ORDER BY id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![conversation_id], |r| {
                Ok(EngineSession {
                    id: r.get(0)?,
                    conversation_id: r.get(1)?,
                    acp_session_id: r.get(2)?,
                    engine: r.get(3)?,
                    reason: reason_from(&r.get::<_, String>(4)?),
                    started_at: r.get(5)?,
                    active: r.get::<_, i64>(6)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    // ── Entries ────────────────────────────────────────────────────────────

    /// Insert a new entry and return its assigned `seq`. The entry's in-memory
    /// `seq` is a placeholder until this returns; callers should set it after.
    pub fn insert_entry(&self, conversation_id: &str, entry: &Entry) -> Result<i64, String> {
        let (kind, status, origin, created_at) = entry_columns(entry);
        let data = serde_json::to_string(entry).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO entries (conversation_id, entry_id, kind, status, origin, created_at, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![conversation_id, entry.entry_id(), kind, status, origin, created_at, data],
            )
            .map_err(|e| e.to_string())?;
        self.touch(conversation_id, created_at)?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Persist the current state of an existing entry (by `entry_id`). Used to
    /// flush a streaming assistant turn and to record terminal status/summary.
    pub fn update_entry(&self, entry: &Entry) -> Result<(), String> {
        let (kind, status, origin, _created) = entry_columns(entry);
        let data = serde_json::to_string(entry).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "UPDATE entries SET kind = ?2, status = ?3, origin = ?4, data = ?5 WHERE entry_id = ?1",
                params![entry.entry_id(), kind, status, origin, data],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn touch(&self, conversation_id: &str, now: i64) -> Result<(), String> {
        self.conn
            .execute("UPDATE conversations SET updated_at = ?2 WHERE id = ?1", params![conversation_id, now])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// The highest `seq` in a conversation (its head), or 0 if empty.
    pub fn head_seq(&self, conversation_id: &str) -> Result<i64, String> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM entries WHERE conversation_id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }

    /// The newest `limit` entries, returned ascending by `seq` (chat order).
    pub fn recent_entries(&self, conversation_id: &str, limit: i64) -> Result<Vec<Entry>, String> {
        self.query_entries(
            "SELECT seq, data FROM entries WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT ?2",
            params![conversation_id, limit],
        )
    }

    /// The `limit` entries older than `before_seq`, ascending by `seq`.
    pub fn entries_before(&self, conversation_id: &str, before_seq: i64, limit: i64) -> Result<Vec<Entry>, String> {
        self.query_entries(
            "SELECT seq, data FROM entries WHERE conversation_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3",
            params![conversation_id, before_seq, limit],
        )
    }

    fn query_entries(&self, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Entry>, String> {
        let mut stmt = self.conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(p, |r| {
                let seq: i64 = r.get(0)?;
                let data: String = r.get(1)?;
                Ok((seq, data))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, data) = row.map_err(|e| e.to_string())?;
            let mut entry: Entry = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            set_seq(&mut entry, seq); // the column is authoritative
            out.push(entry);
        }
        out.reverse(); // DESC query -> ascending result
        Ok(out)
    }

    /// On startup, any assistant turn left mid-flight (non-terminal) can never
    /// resume, so mark it Failed — otherwise the UI shows a permanent spinner.
    /// Returns how many turns were repaired.
    pub fn fail_active_turns(&self) -> Result<usize, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, data FROM entries WHERE kind = 'assistant' AND status IN ('queued','streaming','awaitingPermission')")
            .map_err(|e| e.to_string())?;
        let pending: Vec<(i64, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        let mut n = 0;
        for (seq, data) in pending {
            let mut entry: Entry = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            if let Entry::Assistant(a) = &mut entry {
                a.status = TurnStatus::Failed;
                a.summary = crate::chat::model::compute_collapse(&a.blocks, true);
                set_seq(&mut entry, seq);
                self.update_entry(&entry)?;
                n += 1;
            }
        }
        Ok(n)
    }
}

fn reason_str(r: SessionReason) -> &'static str {
    match r {
        SessionReason::Started => "started",
        SessionReason::Compacted => "compacted",
        SessionReason::Cleared => "cleared",
        SessionReason::Reloaded => "reloaded",
    }
}

fn reason_from(s: &str) -> SessionReason {
    match s {
        "compacted" => SessionReason::Compacted,
        "cleared" => SessionReason::Cleared,
        "reloaded" => SessionReason::Reloaded,
        _ => SessionReason::Started,
    }
}

fn status_str(s: TurnStatus) -> &'static str {
    match s {
        TurnStatus::Queued => "queued",
        TurnStatus::Streaming => "streaming",
        TurnStatus::AwaitingPermission => "awaitingPermission",
        TurnStatus::Completed => "completed",
        TurnStatus::Cancelled => "cancelled",
        TurnStatus::Failed => "failed",
    }
}

/// Column values (kind, status, origin, created_at) derived from an entry.
fn entry_columns(entry: &Entry) -> (&'static str, Option<&'static str>, Option<&'static str>, i64) {
    match entry {
        Entry::User(e) => ("user", None, Some(origin_str(e.origin)), e.created_at),
        Entry::Assistant(e) => ("assistant", Some(status_str(e.status)), Some(origin_str(e.origin)), e.started_at),
        Entry::System(e) => ("system", None, None, e.created_at),
    }
}

fn origin_str(o: crate::chat::model::TurnOrigin) -> &'static str {
    use crate::chat::model::TurnOrigin::*;
    match o {
        User => "user",
        Slash => "slash",
        Lifecycle => "lifecycle",
        Init => "init",
        Autofix => "autofix",
    }
}

fn set_seq(entry: &mut Entry, seq: i64) {
    match entry {
        Entry::User(e) => e.seq = seq,
        Entry::Assistant(e) => e.seq = seq,
        Entry::System(e) => e.seq = seq,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::model::{AssistantEntry, Block, CollapseSummary, SystemEntry, SystemKind, TurnOrigin, UserEntry};

    fn conv(db: &ChatDb) -> Conversation {
        let c = Conversation {
            id: "conv-1".into(),
            workspace_id: "ws-1".into(),
            title: None,
            created_at: 100,
            active_engine_session: None,
        };
        db.create_conversation(&c).unwrap();
        c
    }

    fn user(id: &str, display: &str, sent: &str) -> Entry {
        Entry::User(UserEntry {
            seq: 0,
            entry_id: id.into(),
            display: display.into(),
            sent: sent.into(),
            attachments: vec![],
            model: None,
            variant: None,
            agent: None,
            origin: TurnOrigin::User,
            created_at: 1,
        })
    }

    fn assistant(id: &str, status: TurnStatus, blocks: Vec<Block>) -> Entry {
        Entry::Assistant(AssistantEntry {
            seq: 0,
            entry_id: id.into(),
            engine_session_id: Some(1),
            status,
            origin: TurnOrigin::User,
            blocks,
            summary: CollapseSummary::default(),
            usage: None,
            started_at: 2,
            ended_at: None,
        })
    }

    #[test]
    fn create_and_get_conversation() {
        let db = ChatDb::open_in_memory().unwrap();
        assert!(db.get_conversation("ws-1").unwrap().is_none());
        let c = conv(&db);
        let got = db.get_conversation("ws-1").unwrap().unwrap();
        assert_eq!(got.id, c.id);
        assert_eq!(got.workspace_id, "ws-1");
    }

    #[test]
    fn insert_assigns_monotonic_seq_and_reads_back_ascending() {
        let db = ChatDb::open_in_memory().unwrap();
        conv(&db);
        let s1 = db.insert_entry("conv-1", &user("u1", "hi", "hi")).unwrap();
        let s2 = db.insert_entry("conv-1", &assistant("a1", TurnStatus::Completed, vec![])).unwrap();
        let s3 = db.insert_entry("conv-1", &user("u2", "again", "again")).unwrap();
        assert!(s1 < s2 && s2 < s3);
        let entries = db.recent_entries("conv-1", 10).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].entry_id(), "u1");
        assert_eq!(entries[2].entry_id(), "u2");
        // seq comes from the column, not the stale in-memory placeholder
        assert_eq!(entries[0].seq(), s1);
        assert_eq!(entries[2].seq(), s3);
        assert_eq!(db.head_seq("conv-1").unwrap(), s3);
    }

    #[test]
    fn pagination_before_cursor() {
        let db = ChatDb::open_in_memory().unwrap();
        conv(&db);
        let mut seqs = vec![];
        for i in 0..5 {
            seqs.push(db.insert_entry("conv-1", &user(&format!("u{i}"), "x", "x")).unwrap());
        }
        // newest 2
        let recent = db.recent_entries("conv-1", 2).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].entry_id(), "u3");
        assert_eq!(recent[1].entry_id(), "u4");
        // older page before the oldest-shown
        let older = db.entries_before("conv-1", recent[0].seq(), 10).unwrap();
        assert_eq!(older.len(), 3);
        assert_eq!(older[0].entry_id(), "u0");
        assert_eq!(older[2].entry_id(), "u2");
    }

    #[test]
    fn update_entry_persists_new_state() {
        let db = ChatDb::open_in_memory().unwrap();
        conv(&db);
        let seq = db.insert_entry("conv-1", &assistant("a1", TurnStatus::Streaming, vec![])).unwrap();
        let updated = Entry::Assistant(AssistantEntry {
            seq,
            entry_id: "a1".into(),
            engine_session_id: Some(1),
            status: TurnStatus::Completed,
            origin: TurnOrigin::User,
            blocks: vec![Block::Text { block_id: "t1".into(), text: "hello".into() }],
            summary: CollapseSummary { collapsed: true, headline: "Responded".into(), ..Default::default() },
            usage: None,
            started_at: 2,
            ended_at: Some(9),
        });
        db.update_entry(&updated).unwrap();
        let back = db.recent_entries("conv-1", 10).unwrap();
        match &back[0] {
            Entry::Assistant(a) => {
                assert_eq!(a.status, TurnStatus::Completed);
                assert_eq!(a.blocks.len(), 1);
                assert!(a.summary.collapsed);
            }
            _ => panic!("expected assistant"),
        }
    }

    #[test]
    fn engine_sessions_span_a_conversation() {
        let db = ChatDb::open_in_memory().unwrap();
        conv(&db);
        let s1 = db.add_engine_session("conv-1", "acp-a", "opencode", SessionReason::Started, 10).unwrap();
        let s2 = db.add_engine_session("conv-1", "acp-b", "opencode", SessionReason::Compacted, 20).unwrap();
        assert_ne!(s1.id, s2.id);
        let all = db.list_engine_sessions("conv-1").unwrap();
        assert_eq!(all.len(), 2);
        assert!(!all[0].active, "first session deactivated");
        assert!(all[1].active, "newest session active");
        assert_eq!(all[1].reason, SessionReason::Compacted);
        // conversation now points at the newest engine session
        let c = db.get_conversation("ws-1").unwrap().unwrap();
        assert_eq!(c.active_engine_session.as_deref(), Some("acp-b"));
    }

    #[test]
    fn fail_active_turns_repairs_interrupted() {
        let db = ChatDb::open_in_memory().unwrap();
        conv(&db);
        db.insert_entry("conv-1", &assistant("a1", TurnStatus::Streaming, vec![])).unwrap();
        db.insert_entry("conv-1", &assistant("a2", TurnStatus::Completed, vec![])).unwrap();
        db.insert_entry("conv-1", &user("u1", "x", "x")).unwrap();
        db.insert_entry(
            "conv-1",
            &Entry::System(SystemEntry {
                seq: 0,
                entry_id: "s1".into(),
                kind: SystemKind::Info,
                text: "note".into(),
                created_at: 1,
            }),
        )
        .unwrap();
        let n = db.fail_active_turns().unwrap();
        assert_eq!(n, 1);
        let entries = db.recent_entries("conv-1", 10).unwrap();
        match entries.iter().find(|e| e.entry_id() == "a1").unwrap() {
            Entry::Assistant(a) => assert_eq!(a.status, TurnStatus::Failed),
            _ => panic!(),
        }
        // untouched
        match entries.iter().find(|e| e.entry_id() == "a2").unwrap() {
            Entry::Assistant(a) => assert_eq!(a.status, TurnStatus::Completed),
            _ => panic!(),
        }
    }

    #[test]
    fn durable_across_reopen() {
        let dir = std::env::temp_dir().join(format!("branchlab-chat-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chat.db");
        {
            let db = ChatDb::open(&path).unwrap();
            conv(&db);
            db.insert_entry("conv-1", &user("u1", "persist me", "persist me")).unwrap();
        }
        {
            let db = ChatDb::open(&path).unwrap();
            let entries = db.recent_entries("conv-1", 10).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].entry_id(), "u1");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
