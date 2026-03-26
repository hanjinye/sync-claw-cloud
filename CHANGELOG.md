# Changelog

## 1.1.0-beta.11 - 2026-03-26

- Added PostgreSQL-backed `conversation_turns` storage with backfill and cleanup scripts for historical OpenClaw dialogues.
- Added PostgreSQL-backed `profile_documents` storage for shared core files: `SOUL.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`, and a sanitized `openclaw.json` snapshot.
- Added merge-based core file sync with automatic startup sync, daily interval sync, retention-based local backups, and doc-specific merge rules.
- Added PostgreSQL-backed `profile_sync_events` audit trail plus CLI history/conflict inspection commands.
- Added `profile-sync` CLI commands for `status`, `push`, `pull`, `sync`, `backup`, `history`, and `conflicts`.
- Improved conversation log sanitization to strip injected memory wrappers and untrusted metadata envelopes before persistence.
