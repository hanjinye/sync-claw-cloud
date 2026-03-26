#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import Json


DB_CONFIG = {
    "host": "106.54.212.240",
    "port": 5432,
    "dbname": "sync_claw",
    "user": "postgres",
    "password": "Qitian.ltd1122",
}


SENDER_META_RE = re.compile(
    r"^(?:Conversation info|Sender) \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*",
    re.IGNORECASE,
)
LEADING_TIME_RE = re.compile(
    r"^\[[^\]]+\]\s*",
    re.IGNORECASE,
)
REPLY_MARKER_RE = re.compile(r"^\[\[reply_to_current\]\]\s*", re.IGNORECASE)
RELEVANT_MEMORIES_RE = re.compile(
    r"<relevant-memories>[\s\S]*?\[END UNTRUSTED DATA\][\s\S]*?</relevant-memories>\s*",
    re.IGNORECASE,
)


def normalize_question(text: str) -> str:
    updated = RELEVANT_MEMORIES_RE.sub("", text)
    updated = SENDER_META_RE.sub("", updated)
    updated = LEADING_TIME_RE.sub("", updated)
    return updated.strip()


def normalize_reply(text: str) -> str:
    updated = REPLY_MARKER_RE.sub("", text)
    return updated.strip()


def main() -> None:
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, question, reply, metadata
        FROM sync_claw_cloud.conversation_turns
        WHERE metadata->>'source'='historical-session-backfill'
        ORDER BY id
        """
    )

    updated = 0
    question_updates = 0
    reply_updates = 0

    for row_id, question, reply, metadata in cur.fetchall():
        new_question = normalize_question(question or "")
        new_reply = normalize_reply(reply or "")
        if new_question == (question or "") and new_reply == (reply or ""):
            continue

        meta = metadata if isinstance(metadata, dict) else {}
        meta["cleaned_at"] = datetime.now(timezone.utc).isoformat()
        meta["cleaned_by"] = "clean-conversation-turns.py"
        if new_question != (question or ""):
            question_updates += 1
        if new_reply != (reply or ""):
            reply_updates += 1

        cur.execute(
            """
            UPDATE sync_claw_cloud.conversation_turns
            SET question = %s,
                reply = %s,
                metadata = %s::jsonb
            WHERE id = %s
            """,
            (new_question, new_reply, Json(meta), row_id),
        )
        updated += 1

    conn.commit()
    conn.close()
    print(json.dumps({
        "updated_rows": updated,
        "question_updates": question_updates,
        "reply_updates": reply_updates,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
