#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import Json


HOME = Path.home()
OPENCLAW_HOME = Path.home() / ".openclaw"
AGENTS_DIR = OPENCLAW_HOME / "agents"

DB_CONFIG = {
    "host": "106.54.212.240",
    "port": 5432,
    "dbname": "sync_claw",
    "user": "postgres",
    "password": "Qitian.ltd1122",
}


@dataclass
class SessionMeta:
    session_key: str
    session_file: Path
    origin: dict[str, Any]
    agent_id: str | None


def to_epoch_ms(value: str | None) -> int | None:
    if not value:
      return None
    try:
      dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
      return int(dt.timestamp() * 1000)
    except Exception:
      return None


def extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(part.strip() for part in parts if isinstance(part, str) and part.strip()).strip()


RELEVANT_MEMORIES_RE = re.compile(
    r"<relevant-memories>[\s\S]*?\[END UNTRUSTED DATA\][\s\S]*?</relevant-memories>\s*",
    re.IGNORECASE,
)
SENDER_META_RE = re.compile(
    r"^(?:Conversation info|Sender) \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*",
    re.IGNORECASE,
)
LEADING_TIME_RE = re.compile(r"^\[[^\]]+\]\s*", re.IGNORECASE)
REPLY_MARKER_RE = re.compile(r"^\[\[reply_to_current\]\]\s*", re.IGNORECASE)


def clean_user_text(text: str) -> str:
    text = RELEVANT_MEMORIES_RE.sub("", text)
    text = SENDER_META_RE.sub("", text)
    text = LEADING_TIME_RE.sub("", text)
    text = text.strip()
    return text


def clean_assistant_text(text: str) -> str:
    return REPLY_MARKER_RE.sub("", text).strip()


def load_session_index() -> dict[Path, SessionMeta]:
    by_file: dict[Path, SessionMeta] = {}
    for index_path in AGENTS_DIR.glob("*/sessions/sessions.json"):
        try:
            raw = json.loads(index_path.read_text())
        except Exception:
            continue
        if not isinstance(raw, dict):
            continue
        for session_key, meta in raw.items():
            if not isinstance(meta, dict):
                continue
            session_file_raw = meta.get("sessionFile")
            if not isinstance(session_file_raw, str) or not session_file_raw.strip():
                continue
            session_file = Path(session_file_raw).expanduser()
            agent_id = None
            parts = str(session_key).split(":")
            if len(parts) >= 2 and parts[0] == "agent":
                agent_id = parts[1]
            by_file[session_file] = SessionMeta(
                session_key=str(session_key),
                session_file=session_file,
                origin=meta.get("origin") if isinstance(meta.get("origin"), dict) else {},
                agent_id=agent_id,
            )
    return by_file


def derive_terminal(session_key: str, origin: dict[str, Any]) -> str | None:
    parts = session_key.split(":")
    if len(parts) >= 3:
        return parts[2]
    value = origin.get("provider") or origin.get("label")
    return value if isinstance(value, str) and value.strip() else None


def derive_client(session_key: str) -> str | None:
    parts = session_key.split(":")
    if len(parts) >= 3:
        return parts[2]
    return None


def derive_participant(origin: dict[str, Any], session_key: str) -> str:
    for key in ("from", "to", "label"):
        value = origin.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return session_key


def iter_turns(session_file: Path) -> list[dict[str, Any]]:
    turns: list[dict[str, Any]] = []
    pending_users: list[dict[str, Any]] = []
    with session_file.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if row.get("type") != "message":
                continue
            message = row.get("message")
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            if role == "user":
                text = clean_user_text(extract_text(message.get("content")))
                if not text:
                    continue
                pending_users.append({
                    "text": text,
                    "timestamp": to_epoch_ms(row.get("timestamp")),
                    "message_id": row.get("id"),
                })
            elif role == "assistant":
                text = clean_assistant_text(extract_text(message.get("content")))
                if not text:
                    continue
                if not pending_users:
                    continue
                user = pending_users.pop(0)
                turns.append({
                    "question": user["text"],
                    "reply": text,
                    "user_timestamp": user["timestamp"],
                    "assistant_timestamp": to_epoch_ms(row.get("timestamp")),
                    "user_message_id": user["message_id"],
                    "assistant_message_id": row.get("id"),
                })
    return turns


def ensure_table(cur) -> None:
    cur.execute(
        """
        CREATE SCHEMA IF NOT EXISTS sync_claw_cloud;
        CREATE TABLE IF NOT EXISTS sync_claw_cloud.conversation_turns (
          id bigserial PRIMARY KEY,
          participant text NOT NULL,
          question text NOT NULL,
          reply text NOT NULL,
          terminal text,
          client text,
          session_key text,
          channel_id text,
          conversation_id text,
          account_id text,
          agent_id text,
          user_timestamp bigint,
          assistant_timestamp bigint,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        """
    )


def parse_channel_and_conversation(session_key: str) -> tuple[str | None, str | None]:
    parts = session_key.split(":")
    if len(parts) >= 4:
        return parts[2], ":".join(parts[3:])
    return None, None


def main() -> None:
    session_index = load_session_index()
    session_files = sorted({*session_index.keys(), *AGENTS_DIR.glob("*/sessions/*.jsonl")})
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False
    cur = conn.cursor()
    ensure_table(cur)

    inserted = 0
    skipped = 0
    scanned_sessions = 0

    for session_file in session_files:
        meta = session_index.get(session_file)
        session_key = meta.session_key if meta else f"file:{session_file.stem}"
        origin = meta.origin if meta else {}
        agent_id = meta.agent_id if meta else None
        terminal = derive_terminal(session_key, origin)
        client = derive_client(session_key)
        participant = derive_participant(origin, session_key)
        channel_id, conversation_id = parse_channel_and_conversation(session_key)
        scanned_sessions += 1

        try:
            turns = iter_turns(session_file)
        except Exception:
            continue

        for turn in turns:
            metadata = {
                "source": "historical-session-backfill",
                "session_file": str(session_file),
                "origin": origin,
                "user_message_id": turn["user_message_id"],
                "assistant_message_id": turn["assistant_message_id"],
                "backfilled_at": datetime.now(timezone.utc).isoformat(),
            }
            cur.execute(
                """
                INSERT INTO sync_claw_cloud.conversation_turns (
                  participant, question, reply, terminal, client, session_key,
                  channel_id, conversation_id, account_id, agent_id,
                  user_timestamp, assistant_timestamp, metadata
                )
                SELECT %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM sync_claw_cloud.conversation_turns
                  WHERE session_key = %s
                    AND question = %s
                    AND reply = %s
                    AND COALESCE(user_timestamp, 0) = COALESCE(%s, 0)
                    AND COALESCE(assistant_timestamp, 0) = COALESCE(%s, 0)
                )
                """,
                (
                    participant,
                    turn["question"],
                    turn["reply"],
                    terminal,
                    client,
                    session_key,
                    channel_id,
                    conversation_id,
                    origin.get("from") if isinstance(origin.get("from"), str) else None,
                    agent_id,
                    turn["user_timestamp"],
                    turn["assistant_timestamp"],
                    Json(metadata),
                    session_key,
                    turn["question"],
                    turn["reply"],
                    turn["user_timestamp"],
                    turn["assistant_timestamp"],
                ),
            )
            if cur.rowcount:
                inserted += 1
            else:
                skipped += 1

    conn.commit()
    cur.execute("SELECT COUNT(*) FROM sync_claw_cloud.conversation_turns")
    total = cur.fetchone()[0]
    conn.close()
    print(json.dumps({
        "scanned_sessions": scanned_sessions,
        "inserted": inserted,
        "skipped": skipped,
        "total": total,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
