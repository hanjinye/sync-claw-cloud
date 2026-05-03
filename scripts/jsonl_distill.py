#!/usr/bin/env python3
"""jsonl_distill.py

Incrementally extract new chat messages from OpenClaw session JSONL files and
write a compact batch file for a distiller agent to turn into LanceDB memories.

Design goals:
- Read only the newly-appended tail of each session file (byte-offset cursor).
- Avoid token waste: if there is no new content, produce no batch.
- Safety: never delete/modify session logs.
- Robustness: handle file rotation/truncation using inode+size checks.

This script does NOT call any LLM or write to LanceDB. It only prepares data
for the distiller agent.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_STATE_DIR = Path.home() / ".openclaw" / "state" / "jsonl-distill"
DEFAULT_AGENTS_DIR = Path.home() / ".openclaw" / "agents"

# Prevent self-ingestion loops: the distiller agent itself should never be a source.
EXCLUDED_AGENT_IDS = {
    "memory-distiller",
}

# Source allowlist (optional quality control).
# Default (env unset): allow all agents (except EXCLUDED_AGENT_IDS).
# If set: only distill from the listed agent IDs.
# Example:
#   OPENCLAW_JSONL_DISTILL_ALLOWED_AGENT_IDS=main,code-agent
ENV_ALLOWED_AGENT_IDS = "OPENCLAW_JSONL_DISTILL_ALLOWED_AGENT_IDS"


def _get_allowed_agent_ids() -> Optional[set[str]]:
    raw = os.environ.get(ENV_ALLOWED_AGENT_IDS, "").strip()
    if not raw or raw in ("*", "all"):
        return None
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    return set(parts) if parts else None



NOISE_PREFIXES = (
    "✅ New session started",
    "NO_REPLY",
)

TOKEN_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.:-]{1,}|[\u4e00-\u9fff]")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", errors="ignore")).hexdigest()


def _read_jsonl_lines(path: Path, start_offset: int, max_bytes: int) -> Tuple[List[str], int]:
    """Read up to max_bytes from path starting at start_offset. Returns (lines, end_offset)."""
    lines: List[str] = []
    with path.open("rb") as f:
        f.seek(start_offset)
        data = f.read(max_bytes)
        end_offset = f.tell()

    if not data:
        return [], end_offset

    # Ensure we end on a newline boundary to avoid partial JSON lines.
    if not data.endswith(b"\n"):
        last_nl = data.rfind(b"\n")
        if last_nl == -1:
            # No complete line in this chunk.
            return [], start_offset
        data = data[: last_nl + 1]
        end_offset = start_offset + len(data)

    text = data.decode("utf-8", errors="replace")
    for line in text.splitlines():
        line = line.strip()
        if line:
            lines.append(line)
    return lines, end_offset


def _extract_text_blocks(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str) and t:
                    parts.append(t)
        return "\n".join(parts)
    return ""


def _clean_text(s: str) -> str:
    s = s.strip()
    if not s:
        return ""

    # Drop injected memory blocks entirely.
    if "<relevant-memories>" in s:
        s = re.sub(r"<relevant-memories>[\s\S]*?</relevant-memories>", "", s)

    # Strip OpenClaw transcript headers that add noise but not meaning.
    # Keep the actual user content that follows.
    s = re.sub(r"^Conversation info \(untrusted metadata\):\s*\n+", "", s, flags=re.IGNORECASE)
    s = re.sub(r"^Replied message \(untrusted, for context\):\s*\n+", "", s, flags=re.IGNORECASE)

    # Drop embedded JSON blocks (often metadata) to reduce token waste.
    s = re.sub(r"```json[\s\S]*?```", "", s)

    # Collapse whitespace.
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _tokenize(text: str) -> List[str]:
    tokens = [m.group(0).lower() for m in TOKEN_RE.finditer(text)]
    return [t for t in tokens if len(t) > 1 or re.match(r"[\u4e00-\u9fff]", t)]


def _top_terms(text: str, limit: int = 16) -> List[str]:
    counts = Counter(_tokenize(text))
    return [term for term, _ in counts.most_common(limit)]


def _noise_reason(s: str) -> Optional[str]:
    if not s:
        return "empty"
    if s.lstrip().startswith("/"):
        return "slash_command"
    for p in NOISE_PREFIXES:
        if s.startswith(p):
            return "noise_prefix"

    lower = s.lower()

    # Drop transcript/system boilerplate that should never become memories.
    if "[queued messages while agent was busy]" in lower:
        return "queued_messages"
    if "you are running a boot check" in lower or "boot.md — gateway startup health check" in lower:
        return "boot_check"
    if "read heartbeat.md" in lower:
        return "heartbeat"
    if "[claude_code_done]" in lower or "claude_code_done" in lower:
        return "done_marker"

    # Skip overly long blocks (logs / dumps). The distiller can still capture the essence later.
    if len(s) > 2000:
        return "oversized_block"

    # Skip pure code fences (usually tool output).
    if s.strip().startswith("```") and s.strip().endswith("```"):
        return "pure_code_fence"

    return None


def _is_noise(s: str) -> bool:
    return _noise_reason(s) is not None


def _timestamp_to_ms(value: Any) -> Optional[int]:
    if isinstance(value, (int, float)):
        n = int(value)
        return n if n > 10_000_000_000 else n * 1000
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.isdigit():
        return _timestamp_to_ms(int(raw))
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


def _decay_score(timestamp: Any, half_life_days: float, now_ms: Optional[int] = None) -> Dict[str, Any]:
    ts_ms = _timestamp_to_ms(timestamp)
    now = now_ms or _now_ms()
    if not ts_ms or half_life_days <= 0:
        return {"createdAtMs": ts_ms, "ageDays": None, "recency": 1.0}
    age_days = max(0.0, (now - ts_ms) / 86_400_000)
    recency = math.exp(-math.log(2) * age_days / half_life_days)
    return {
        "createdAtMs": ts_ms,
        "ageDays": round(age_days, 4),
        "recency": round(max(0.0, min(1.0, recency)), 6),
    }


def _quality_score(text: str, role: str) -> Dict[str, Any]:
    reason = _noise_reason(text)
    terms = _top_terms(text)
    char_len = len(text)
    density = min(1.0, len(terms) / 12.0)
    length_score = 1.0 if 40 <= char_len <= 900 else (0.65 if char_len < 40 else 0.45)
    role_score = 0.95 if role == "user" else 0.85
    score = 0.0 if reason else max(0.0, min(1.0, 0.2 + 0.45 * density + 0.25 * length_score + 0.1 * role_score))
    return {
        "score": round(score, 4),
        "noiseReason": reason,
        "charLen": char_len,
        "lexicalTerms": terms,
    }


def _bm25_scores(messages: List[Dict[str, Any]], query: str, k1: float = 1.5, b: float = 0.75) -> None:
    query_terms = _tokenize(query)
    if not query_terms or not messages:
        for msg in messages:
            msg.setdefault("retrieval", {})["bm25Score"] = None
        return

    docs = [_tokenize(str(msg.get("text", ""))) for msg in messages]
    avgdl = sum(len(doc) for doc in docs) / max(1, len(docs))
    df = Counter()
    for doc in docs:
        for term in set(doc):
            df[term] += 1

    n_docs = len(docs)
    for msg, doc in zip(messages, docs):
        tf = Counter(doc)
        score = 0.0
        dl = len(doc) or 1
        for term in query_terms:
            if tf[term] <= 0:
                continue
            idf = math.log(1 + (n_docs - df[term] + 0.5) / (df[term] + 0.5))
            denom = tf[term] + k1 * (1 - b + b * dl / max(avgdl, 1e-9))
            score += idf * (tf[term] * (k1 + 1)) / denom
        msg.setdefault("retrieval", {})["bm25Score"] = round(score, 6)


@dataclass
class CursorEntry:
    inode: int
    committed: int
    pending: Optional[int] = None
    pending_batch: Optional[str] = None
    last_size: Optional[int] = None


def _load_cursor(cursor_path: Path) -> Dict[str, Any]:
    if not cursor_path.exists():
        return {"version": 1, "files": {}, "createdAtMs": _now_ms(), "updatedAtMs": _now_ms()}
    return json.loads(cursor_path.read_text("utf-8"))


def _save_cursor(cursor_path: Path, cursor: Dict[str, Any]) -> None:
    cursor["updatedAtMs"] = _now_ms()
    cursor_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = cursor_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cursor, ensure_ascii=False, indent=2) + "\n", "utf-8")
    tmp.replace(cursor_path)


def _list_session_files(agents_dir: Path) -> List[Tuple[str, Path]]:
    results: List[Tuple[str, Path]] = []
    if not agents_dir.exists():
        return results

    allowed_agent_ids = _get_allowed_agent_ids()

    for agent_dir in sorted(agents_dir.iterdir()):
        if not agent_dir.is_dir():
            continue
        agent_id = agent_dir.name
        if agent_id in EXCLUDED_AGENT_IDS:
            continue
        if allowed_agent_ids is not None and agent_id not in allowed_agent_ids:
            continue
        sessions_dir = agent_dir / "sessions"
        if not sessions_dir.exists():
            continue

        for f in sorted(sessions_dir.iterdir()):
            name = f.name
            if not f.is_file():
                continue
            if not name.endswith(".jsonl"):
                continue
            if ".reset." in name:
                # Reset snapshots are historical; we start from now and focus on live session tails.
                continue
            if name.endswith(".lock") or ".deleted." in name:
                continue
            results.append((agent_id, f))

    return results


def init_from_now(state_dir: Path, agents_dir: Path) -> Dict[str, Any]:
    cursor_path = state_dir / "cursor.json"
    cursor = _load_cursor(cursor_path)
    files = cursor.setdefault("files", {})

    for agent_id, f in _list_session_files(agents_dir):
        st = f.stat()
        key = str(f)
        files[key] = {
            "agentId": agent_id,
            "inode": int(st.st_ino),
            "committed": int(st.st_size),
            "pending": None,
            "pendingBatch": None,
            "lastSize": int(st.st_size),
            "updatedAtMs": _now_ms(),
        }

    _save_cursor(cursor_path, cursor)
    return {
        "ok": True,
        "action": "init",
        "cursorPath": str(cursor_path),
        "trackedFiles": len(files),
    }


def run_extract(
    state_dir: Path,
    agents_dir: Path,
    max_bytes_per_file: int,
    max_messages_per_agent: int,
    bm25_query: str = "",
    decay_half_life_days: float = 30.0,
    min_quality_score: float = 0.0,
) -> Dict[str, Any]:
    cursor_path = state_dir / "cursor.json"
    cursor = _load_cursor(cursor_path)
    files: Dict[str, Any] = cursor.setdefault("files", {})

    # If there is a pending batch, return it and do not read new data.
    pending_batches = sorted({v.get("pendingBatch") for v in files.values() if v.get("pendingBatch")})
    pending_batches = [b for b in pending_batches if b]
    if pending_batches:
        return {
            "ok": True,
            "action": "pending",
            "batchFiles": pending_batches,
            "cursorPath": str(cursor_path),
        }

    # Collect new messages.
    per_agent_msgs: Dict[str, List[Dict[str, Any]]] = {}
    touched_files: List[Dict[str, Any]] = []
    filtered_counts: Dict[str, int] = {}

    for agent_id, f in _list_session_files(agents_dir):
        key = str(f)
        st = f.stat()
        inode = int(st.st_ino)
        size = int(st.st_size)

        entry = files.get(key)
        committed = 0
        if entry and entry.get("inode") == inode:
            committed = int(entry.get("committed") or 0)
            # Handle truncation.
            if size < committed:
                committed = 0
        else:
            # New file not tracked yet: start from EOF (A-mode behavior).
            committed = size

        if size <= committed:
            # Nothing new.
            files[key] = {
                "agentId": agent_id,
                "inode": inode,
                "committed": committed,
                "pending": None,
                "pendingBatch": None,
                "lastSize": size,
                "updatedAtMs": _now_ms(),
            }
            continue

        lines, end_offset = _read_jsonl_lines(f, committed, max_bytes_per_file)
        if not lines:
            # Might have hit partial line boundary; do not advance.
            continue

        extracted: List[Dict[str, Any]] = []
        for line in lines:
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") != "message":
                continue
            msg = obj.get("message")
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            if role not in ("user", "assistant"):
                continue

            text = _extract_text_blocks(msg.get("content"))
            text = _clean_text(text)
            quality = _quality_score(text, role)
            noise_reason = quality.get("noiseReason")
            if noise_reason:
                filtered_counts[str(noise_reason)] = filtered_counts.get(str(noise_reason), 0) + 1
                continue
            if float(quality["score"]) < min_quality_score:
                filtered_counts["low_quality"] = filtered_counts.get("low_quality", 0) + 1
                continue

            ts = obj.get("timestamp") or msg.get("timestamp")
            decay = _decay_score(ts, decay_half_life_days)

            extracted.append({
                "ts": ts,
                "role": role,
                "text": text,
                "textHash": _sha256(text),
                "quality": quality,
                "decay": decay,
                "retrieval": {
                    "bm25Terms": quality["lexicalTerms"],
                    "bm25Score": None,
                },
            })

        if not extracted:
            # Advance committed to end_offset anyway to avoid re-reading pure noise.
            files[key] = {
                "agentId": agent_id,
                "inode": inode,
                "committed": end_offset,
                "pending": None,
                "pendingBatch": None,
                "lastSize": size,
                "updatedAtMs": _now_ms(),
            }
            continue

        per_agent_msgs.setdefault(agent_id, []).extend(extracted)
        touched_files.append({
            "path": key,
            "agentId": agent_id,
            "inode": inode,
            "committed": committed,
            "pending": end_offset,
            "size": size,
        })

    # Cap messages per agent to keep token usage stable.
    for agent_id, msgs in per_agent_msgs.items():
        if len(msgs) > max_messages_per_agent:
            per_agent_msgs[agent_id] = msgs[-max_messages_per_agent:]
        _bm25_scores(per_agent_msgs[agent_id], bm25_query)

    if not per_agent_msgs:
        _save_cursor(cursor_path, cursor)
        return {
            "ok": True,
            "action": "noop",
            "cursorPath": str(cursor_path),
        }

    batches_dir = state_dir / "batches"
    batches_dir.mkdir(parents=True, exist_ok=True)
    batch_id = time.strftime("%Y%m%d-%H%M%S")
    batch_path = batches_dir / f"batch-{batch_id}.json"

    batch_obj = {
        "version": 1,
        "createdAtMs": _now_ms(),
        "agents": [
            {
                "agentId": agent_id,
                "messages": per_agent_msgs.get(agent_id, []),
            }
            for agent_id in sorted(per_agent_msgs.keys())
        ],
        "touchedFiles": touched_files,
        "bridge": {
            "bm25Query": bm25_query or None,
            "decayHalfLifeDays": decay_half_life_days,
            "minQualityScore": min_quality_score,
            "filteredCounts": filtered_counts,
        },
    }

    batch_path.write_text(json.dumps(batch_obj, ensure_ascii=False, indent=2) + "\n", "utf-8")

    # Write pending offsets.
    for tf in touched_files:
        key = tf["path"]
        files[key] = {
            "agentId": tf["agentId"],
            "inode": tf["inode"],
            "committed": tf["committed"],
            "pending": tf["pending"],
            "pendingBatch": str(batch_path),
            "lastSize": tf["size"],
            "updatedAtMs": _now_ms(),
        }

    _save_cursor(cursor_path, cursor)

    return {
        "ok": True,
        "action": "created",
        "batchFile": str(batch_path),
        "agents": len(per_agent_msgs),
        "cursorPath": str(cursor_path),
    }


def commit_batch(state_dir: Path, batch_file: Path) -> Dict[str, Any]:
    cursor_path = state_dir / "cursor.json"
    cursor = _load_cursor(cursor_path)
    files: Dict[str, Any] = cursor.setdefault("files", {})

    committed_files = 0
    for key, v in list(files.items()):
        if v.get("pendingBatch") != str(batch_file):
            continue
        pending = v.get("pending")
        if pending is None:
            continue
        v["committed"] = int(pending)
        v["pending"] = None
        v["pendingBatch"] = None
        v["updatedAtMs"] = _now_ms()
        files[key] = v
        committed_files += 1

    _save_cursor(cursor_path, cursor)
    try:
        batch_file.unlink()
    except Exception:
        pass

    return {
        "ok": True,
        "action": "committed",
        "cursorPath": str(cursor_path),
        "committedFiles": committed_files,
        "batchFile": str(batch_file),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-dir", default=str(DEFAULT_STATE_DIR))
    ap.add_argument("--agents-dir", default=str(DEFAULT_AGENTS_DIR))

    sub = ap.add_subparsers(dest="cmd", required=True)

    s_init = sub.add_parser("init", help="Initialize cursor to EOF for all current session files")

    s_run = sub.add_parser("run", help="Extract incremental message tail and create a batch file")
    s_run.add_argument("--max-bytes-per-file", type=int, default=256_000)
    s_run.add_argument("--max-messages-per-agent", type=int, default=30)
    s_run.add_argument("--bm25-query", default="", help="Optional query used to annotate extracted messages with BM25 scores")
    s_run.add_argument("--decay-half-life-days", type=float, default=30.0)
    s_run.add_argument("--min-quality-score", type=float, default=0.0)

    s_commit = sub.add_parser("commit", help="Commit a processed batch (advance committed offsets)")
    s_commit.add_argument("--batch-file", required=True)

    args = ap.parse_args()

    state_dir = Path(args.state_dir).expanduser().resolve()
    agents_dir = Path(args.agents_dir).expanduser().resolve()

    if args.cmd == "init":
        out = init_from_now(state_dir, agents_dir)
        print(json.dumps(out, ensure_ascii=False))
        return 0

    if args.cmd == "run":
        out = run_extract(
            state_dir,
            agents_dir,
            max_bytes_per_file=int(args.max_bytes_per_file),
            max_messages_per_agent=int(args.max_messages_per_agent),
            bm25_query=str(args.bm25_query or ""),
            decay_half_life_days=float(args.decay_half_life_days),
            min_quality_score=float(args.min_quality_score),
        )
        print(json.dumps(out, ensure_ascii=False))
        return 0

    if args.cmd == "commit":
        out = commit_batch(state_dir, Path(args.batch_file).expanduser().resolve())
        print(json.dumps(out, ensure_ascii=False))
        return 0

    raise RuntimeError("unreachable")


if __name__ == "__main__":
    raise SystemExit(main())
