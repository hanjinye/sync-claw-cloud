from __future__ import annotations

import json
import math
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List

from agent.memory_provider import MemoryProvider


_NOISE_PATTERNS = [
    re.compile(r"^\s*/\w+", re.I),
    re.compile(r"\bdo you (remember|recall|know about)\b", re.I),
    re.compile(r"\b(i don'?t remember|i don'?t recall|no relevant memories found)\b", re.I),
    re.compile(r"^\s*(hi|hello|hey|new session|fresh session)\b", re.I),
    re.compile(r"\[queued messages while agent was busy\]", re.I),
    re.compile(r"claude_code_done", re.I),
]


def _is_noise(text: str) -> bool:
    stripped = (text or "").strip()
    if len(stripped) < 5:
        return True
    if len(stripped) > 4000:
        return True
    return any(pattern.search(stripped) for pattern in _NOISE_PATTERNS)


def _normalize_bm25_score(raw: float) -> float:
    if not math.isfinite(raw):
        return 0.0
    return max(0.0, min(1.0, 1.0 - math.exp(-max(raw, 0.0) / 5.0)))


def _decay_multiplier(timestamp_ms: Any, importance: Any, half_life_days: float = 60.0) -> float:
    try:
        ts = float(timestamp_ms)
    except Exception:
        return 1.0
    if ts <= 0 or half_life_days <= 0:
        return 1.0
    try:
        imp = max(0.0, min(float(importance or 0.5), 1.0))
    except Exception:
        imp = 0.5
    age_days = max(0.0, ((time.time() * 1000) - ts) / 86_400_000)
    effective_half_life = half_life_days * math.exp(1.2 * imp)
    recency = math.exp(-math.log(2) * age_days / effective_half_life)
    return max(0.35, min(1.0, recency))


def _parse_env_file(path: Path) -> dict:
    data: dict[str, str] = {}
    if not path.exists():
        return data
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value.startswith("export "):
            value = value[len("export "):].strip()
        if ((value.startswith('"') and value.endswith('"')) or
                (value.startswith("'") and value.endswith("'"))):
            value = value[1:-1]
        data[key] = value
    return data


def _load_openclaw_plugin_config() -> dict:
    candidates = [Path.home() / ".openclaw" / "openclaw.json"]
    for path in candidates:
        if not path.exists():
            continue
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
            plugins = obj.get("plugins", {})
            if isinstance(plugins.get("entries"), dict):
                entry = plugins["entries"].get("sync-claw-cloud")
                if entry and isinstance(entry, dict):
                    return entry.get("config", {}) or {}
            if isinstance(plugins.get("configs"), dict):
                entry = plugins["configs"].get("sync-claw-cloud")
                if entry and isinstance(entry, dict):
                    return entry.get("config", {}) or {}
        except Exception:
            continue
    return {}


class SyncClawCloudMemoryProvider(MemoryProvider):
    def __init__(self):
        self._session_id = ""
        self._platform = "cli"
        self._hermes_home = Path.home() / ".hermes"
        self._env: dict[str, str] = {}
        self._plugin_cfg: dict[str, Any] = {}
        self._pg_schema = "sync_claw_cloud"
        self._pg_table = "memories"
        self._embed_base = "http://127.0.0.1:11434/v1"
        self._embed_model = "qwen3-embedding:4b"
        self._embed_key = "dummy"
        self._agent_scope = "agent:main"
        self._user_id = ""
        self._initialized = False

    @property
    def name(self) -> str:
        return "sync_claw_cloud"

    def _merged_env(self) -> dict:
        merged: dict[str, str] = {}
        merged.update(_parse_env_file(self._hermes_home / "sync-claw-cloud.env"))
        merged.update(_parse_env_file(self._hermes_home / ".env"))
        merged.update(_parse_env_file(Path.home() / ".openclaw" / ".env"))
        merged.update({k: v for k, v in os.environ.items() if isinstance(v, str)})
        return merged

    def _load_runtime_config(self) -> None:
        self._env = self._merged_env()
        self._plugin_cfg = _load_openclaw_plugin_config()
        postgres_cfg = self._plugin_cfg.get("postgres", {}) if isinstance(self._plugin_cfg, dict) else {}
        embedding_cfg = self._plugin_cfg.get("embedding", {}) if isinstance(self._plugin_cfg, dict) else {}
        self._pg_schema = (
            self._env.get("SYNC_CLAW_CLOUD_PGSCHEMA")
            or self._env.get("POSTGRES_SCHEMA")
            or postgres_cfg.get("schema")
            or "sync_claw_cloud"
        )
        self._pg_table = (
            self._env.get("SYNC_CLAW_CLOUD_PGTABLE")
            or self._env.get("POSTGRES_TABLE")
            or postgres_cfg.get("tableName")
            or "memories"
        )
        self._embed_base = (
            self._env.get("EMBEDDING_BASE_URL")
            or embedding_cfg.get("baseURL")
            or "http://127.0.0.1:11434/v1"
        ).rstrip("/")
        self._embed_model = (
            self._env.get("EMBEDDING_MODEL")
            or embedding_cfg.get("model")
            or "qwen3-embedding:4b"
        )
        self._embed_key = (
            self._env.get("EMBEDDING_API_KEY")
            or embedding_cfg.get("apiKey")
            or "dummy"
        )

    def is_available(self) -> bool:
        try:
            import psycopg2  # noqa: F401
            import requests  # noqa: F401
        except Exception:
            return False
        self._load_runtime_config()
        required = ["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"]
        return all(self._env.get(k) for k in required) and bool(self._embed_base and self._embed_model)

    def initialize(self, session_id: str, **kwargs) -> None:
        self._hermes_home = Path(kwargs.get("hermes_home") or (Path.home() / ".hermes"))
        self._session_id = session_id or ""
        self._platform = kwargs.get("platform") or "cli"
        self._user_id = kwargs.get("user_id") or ""
        self._agent_scope = kwargs.get("agent_workspace") or "agent:main"
        self._load_runtime_config()
        self._initialized = True

    def system_prompt_block(self) -> str:
        return (
            "# sync-claw-cloud Memory\n"
            "Active. Connected to the legacy PostgreSQL memory store for large-history recall.\n"
            "Default recall is safety-scoped to global memories only; agent-scope recall is available via the explicit search tool when needed.\n"
            "Use sync_claw_cloud_context for task-relevant recall, sync_claw_cloud_search for direct lookup, and sync_claw_cloud_remember for durable explicit facts."
        )

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "sync_claw_cloud_search",
                "description": "Search the legacy sync-claw-cloud PostgreSQL memory store. Default scope is global for safer recall.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What to search for."},
                        "top_k": {"type": "integer", "description": "Max results (default 8, max 12)."},
                        "scope_mode": {"type": "string", "enum": ["global", "global+agent"], "description": "global by default. global+agent may surface more legacy notes."},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "sync_claw_cloud_context",
                "description": "Return a compact context block from the legacy sync-claw-cloud memory store for the current task.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "The current task or question."},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "sync_claw_cloud_remember",
                "description": "Persist an explicit long-term fact into the legacy sync-claw-cloud PostgreSQL memory store.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "The memory to store."},
                        "category": {"type": "string", "enum": ["fact", "preference", "decision", "other"], "description": "Memory category (default fact)."},
                        "importance": {"type": "number", "description": "Importance 0-1 (default 0.9)."},
                        "scope": {"type": "string", "enum": ["global", "agent:main"], "description": "Write scope (default global)."},
                    },
                    "required": ["content"],
                },
            },
            {
                "name": "sync_claw_cloud_stats",
                "description": "Show connection and row-count diagnostics for the legacy sync-claw-cloud memory store.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        ]

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not query.strip():
            return ""
        try:
            rows = self._hybrid_search(query, top_k=4, scope_mode="global")
        except Exception:
            return ""
        if not rows:
            return ""
        bullets = []
        for row in rows[:4]:
            text = row.get("text", "").strip().replace("\n", " ")
            if len(text) > 180:
                text = text[:177] + "..."
            bullets.append(f"- [{row.get('category', 'fact')}] {text}")
        return "## sync-claw-cloud Recall\n" + "\n".join(bullets)

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if tool_name == "sync_claw_cloud_search":
            query = str(args.get("query", "")).strip()
            if not query:
                return json.dumps({"error": "query is required"}, ensure_ascii=False)
            top_k = min(max(int(args.get("top_k", 8) or 8), 1), 12)
            scope_mode = str(args.get("scope_mode", "global") or "global")
            return json.dumps({"results": self._hybrid_search(query, top_k=top_k, scope_mode=scope_mode)}, ensure_ascii=False)

        if tool_name == "sync_claw_cloud_context":
            query = str(args.get("query", "")).strip()
            if not query:
                return json.dumps({"error": "query is required"}, ensure_ascii=False)
            rows = self._hybrid_search(query, top_k=5, scope_mode="global")
            lines = []
            for idx, row in enumerate(rows, 1):
                text = row.get("text", "").strip()
                if len(text) > 260:
                    text = text[:257] + "..."
                lines.append(f"{idx}. [{row.get('category', 'fact')}] {text}")
            return json.dumps({"context": "\n".join(lines), "results": rows}, ensure_ascii=False)

        if tool_name == "sync_claw_cloud_remember":
            content = str(args.get("content", "")).strip()
            if not content:
                return json.dumps({"error": "content is required"}, ensure_ascii=False)
            category = str(args.get("category", "fact") or "fact")
            importance = float(args.get("importance", 0.9) or 0.9)
            scope = str(args.get("scope", "global") or "global")
            row = self._insert_memory(content=content, category=category, importance=importance, scope=scope)
            return json.dumps({"ok": True, "memory": row}, ensure_ascii=False)

        if tool_name == "sync_claw_cloud_stats":
            return json.dumps(self._stats(), ensure_ascii=False)

        return json.dumps({"error": f"unknown tool: {tool_name}"}, ensure_ascii=False)

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        if action != "add" or not content.strip():
            return
        category = "preference" if target == "user" else "fact"
        try:
            self._insert_memory(content=content.strip(), category=category, importance=0.95, scope="global")
        except Exception:
            return

    def _connect(self):
        import psycopg2
        cfg = {
            "host": self._env.get("POSTGRES_HOST"),
            "port": int(self._env.get("POSTGRES_PORT", "5432")),
            "dbname": self._env.get("POSTGRES_DB"),
            "user": self._env.get("POSTGRES_USER"),
            "password": self._env.get("POSTGRES_PASSWORD"),
        }
        if self._env.get("POSTGRES_SSLMODE"):
            cfg["sslmode"] = self._env.get("POSTGRES_SSLMODE")
        return psycopg2.connect(**cfg)

    def _embed(self, text: str) -> list[float]:
        import requests
        headers = {
            "Authorization": f"Bearer {self._embed_key}",
            "Content-Type": "application/json",
        }
        try:
            resp = requests.post(
                f"{self._embed_base}/embeddings",
                headers=headers,
                json={"model": self._embed_model, "input": text},
                timeout=20,
            )
            resp.raise_for_status()
            payload = resp.json()
            return payload["data"][0]["embedding"]
        except Exception:
            if "127.0.0.1:11434" not in self._embed_base and "localhost:11434" not in self._embed_base:
                raise

        for endpoint, body in (
            ("http://127.0.0.1:11434/api/embed", {"model": self._embed_model, "input": text}),
            ("http://127.0.0.1:11434/api/embeddings", {"model": self._embed_model, "prompt": text}),
        ):
            resp = requests.post(endpoint, headers={"Content-Type": "application/json"}, json=body, timeout=20)
            resp.raise_for_status()
            payload = resp.json()
            if isinstance(payload.get("embeddings"), list):
                return payload["embeddings"][0]
            if isinstance(payload.get("embedding"), list):
                return payload["embedding"]
        raise RuntimeError(f"embedding endpoint returned no vector for model {self._embed_model}")

    def _vector_literal(self, embedding: list[float]) -> str:
        return "[" + ",".join(str(x) for x in embedding) + "]"

    def _effective_scopes(self, scope_mode: str) -> list[str]:
        if scope_mode == "global+agent":
            return ["global", "agent:main"]
        return ["global"]

    def _hybrid_search(self, query: str, *, top_k: int = 8, scope_mode: str = "global") -> list[dict[str, Any]]:
        try:
            embedding = self._embed(query)
            vector_rows = self._vector_search(query, embedding=embedding, top_k=max(top_k * 2, 12), scope_mode=scope_mode)
        except Exception:
            vector_rows = []
        bm25_rows = self._bm25_search(query, top_k=max(top_k * 2, 12), scope_mode=scope_mode)

        by_id: dict[str, dict[str, Any]] = {}
        for rank, row in enumerate(vector_rows, 1):
            row["vector_rank"] = rank
            row["bm25_rank"] = None
            row["bm25_score"] = 0.0
            by_id[row["id"]] = row
        for rank, row in enumerate(bm25_rows, 1):
            existing = by_id.get(row["id"])
            if existing:
                existing["bm25_rank"] = rank
                existing["bm25_score"] = row.get("bm25_score", 0.0)
                existing["lexical_hit"] = True
            else:
                row["vector_rank"] = None
                row["vector_score"] = 0.0
                row["bm25_rank"] = rank
                by_id[row["id"]] = row

        fused = []
        for row in by_id.values():
            if _is_noise(row.get("text", "")):
                continue
            vector_score = float(row.get("vector_score") or 0.0)
            bm25_score = float(row.get("bm25_score") or 0.0)
            decay = _decay_multiplier(row.get("timestamp"), row.get("importance"))
            exact_bonus = 0.08 if row.get("lexical_hit") else 0.0
            score = min(1.0, ((vector_score * 0.68) + (bm25_score * 0.32) + exact_bonus) * decay)
            row["score"] = round(score, 4)
            row["decay_multiplier"] = round(decay, 4)
            fused.append(row)

        fused.sort(key=lambda r: (r.get("score", 0.0), r.get("importance", 0.0)), reverse=True)
        return fused[:top_k]

    def _vector_search(self, query: str, *, embedding: list[float], top_k: int, scope_mode: str) -> list[dict[str, Any]]:
        from psycopg2 import sql

        vec = self._vector_literal(embedding)
        scopes = self._effective_scopes(scope_mode)
        conn = self._connect()
        try:
            cur = conn.cursor()
            stmt = sql.SQL(
                """
                select
                  id,
                  text,
                  category,
                  scope,
                  importance,
                  timestamp,
                  coalesce(metadata::text, '{{}}') as metadata_text,
                  (1 - (vector <=> %s::vector)) as vec_score
                from {}.{}
                where scope = any(%s)
                order by (vector <=> %s::vector) asc,
                         importance desc nulls last,
                         timestamp desc
                limit %s
                """
            ).format(sql.Identifier(self._pg_schema), sql.Identifier(self._pg_table))
            cur.execute(stmt, (vec, scopes, vec, top_k))
            rows = []
            for rec in cur.fetchall():
                meta = {}
                try:
                    meta = json.loads(rec[6]) if rec[6] else {}
                except Exception:
                    meta = {}
                rows.append({
                    "id": rec[0],
                    "text": rec[1],
                    "category": rec[2],
                    "scope": rec[3],
                    "importance": rec[4],
                    "timestamp": rec[5],
                    "metadata": meta,
                    "vector_score": round(max(0.0, float(rec[7] or 0.0)), 4),
                    "lexical_hit": False,
                })
            cur.close()
            return rows
        finally:
            conn.close()

    def _bm25_search(self, query: str, *, top_k: int, scope_mode: str) -> list[dict[str, Any]]:
        from psycopg2 import sql

        scopes = self._effective_scopes(scope_mode)
        conn = self._connect()
        try:
            cur = conn.cursor()
            stmt = sql.SQL(
                """
                select
                  id,
                  text,
                  category,
                  scope,
                  importance,
                  timestamp,
                  coalesce(metadata::text, '{{}}') as metadata_text,
                  paradedb.score(id) as bm25_score
                from {}.{}
                where text ||| %s
                  and scope = any(%s)
                order by bm25_score desc, timestamp desc
                limit %s
                """
            ).format(sql.Identifier(self._pg_schema), sql.Identifier(self._pg_table))
            cur.execute(stmt, (query, scopes, top_k))
            rows = []
            for rec in cur.fetchall():
                try:
                    meta = json.loads(rec[6]) if rec[6] else {}
                except Exception:
                    meta = {}
                raw_bm25 = float(rec[7] or 0.0)
                rows.append({
                    "id": rec[0],
                    "text": rec[1],
                    "category": rec[2],
                    "scope": rec[3],
                    "importance": rec[4],
                    "timestamp": rec[5],
                    "metadata": meta,
                    "bm25_score": round(_normalize_bm25_score(raw_bm25), 4),
                    "raw_bm25_score": round(raw_bm25, 4),
                    "lexical_hit": True,
                })
            cur.close()
            return rows
        except Exception:
            return self._lexical_fallback_search(query, top_k=top_k, scope_mode=scope_mode)
        finally:
            conn.close()

    def _lexical_fallback_search(self, query: str, *, top_k: int, scope_mode: str) -> list[dict[str, Any]]:
        from psycopg2 import sql

        scopes = self._effective_scopes(scope_mode)
        like = f"%{query}%"
        conn = self._connect()
        try:
            cur = conn.cursor()
            stmt = sql.SQL(
                """
                select id, text, category, scope, importance, timestamp, coalesce(metadata::text, '{{}}') as metadata_text
                from {}.{}
                where text ilike %s and scope = any(%s)
                order by importance desc nulls last, timestamp desc
                limit %s
                """
            ).format(sql.Identifier(self._pg_schema), sql.Identifier(self._pg_table))
            cur.execute(stmt, (like, scopes, top_k))
            rows = []
            for rec in cur.fetchall():
                try:
                    meta = json.loads(rec[6]) if rec[6] else {}
                except Exception:
                    meta = {}
                rows.append({
                    "id": rec[0],
                    "text": rec[1],
                    "category": rec[2],
                    "scope": rec[3],
                    "importance": rec[4],
                    "timestamp": rec[5],
                    "metadata": meta,
                    "bm25_score": 0.62,
                    "raw_bm25_score": None,
                    "lexical_hit": True,
                })
            cur.close()
            return rows
        finally:
            conn.close()

    def _insert_memory(self, *, content: str, category: str, importance: float, scope: str) -> dict[str, Any]:
        from psycopg2 import sql

        category = category if category in {"fact", "preference", "decision", "other"} else "fact"
        scope = scope if scope in {"global", "agent:main"} else "global"
        importance = max(0.0, min(float(importance), 1.0))
        embedding = self._embed(content)
        vec = self._vector_literal(embedding)
        memory_id = str(uuid.uuid4())
        now_ms = int(time.time() * 1000)
        metadata = {
            "source": "hermes-sync-claw-cloud-bridge",
            "platform": self._platform,
            "session_key": self._session_id or "hermes",
            "memory_category": category,
            "state": "confirmed",
            "confidence": 0.9,
        }
        conn = self._connect()
        try:
            cur = conn.cursor()
            stmt = sql.SQL(
                """
                insert into {}.{}
                (id, text, vector, category, scope, importance, timestamp, metadata, terminal, client, session_key)
                values (%s, %s, %s::vector, %s, %s, %s, %s, %s::jsonb, %s, %s, %s)
                """
            ).format(sql.Identifier(self._pg_schema), sql.Identifier(self._pg_table))
            cur.execute(stmt, (
                memory_id,
                content,
                vec,
                category,
                scope,
                importance,
                now_ms,
                json.dumps(metadata, ensure_ascii=False),
                self._platform,
                "hermes",
                self._session_id or "hermes",
            ))
            conn.commit()
            cur.close()
        finally:
            conn.close()
        return {
            "id": memory_id,
            "category": category,
            "scope": scope,
            "importance": importance,
            "content": content,
        }

    def _stats(self) -> dict[str, Any]:
        from psycopg2 import sql

        conn = self._connect()
        try:
            cur = conn.cursor()
            stmt = sql.SQL("select count(*), count(*) filter (where scope='global') from {}.{}").format(
                sql.Identifier(self._pg_schema), sql.Identifier(self._pg_table)
            )
            cur.execute(stmt)
            total, global_count = cur.fetchone()
            cur.close()
        finally:
            conn.close()
        return {
            "ok": True,
            "provider": self.name,
            "schema": self._pg_schema,
            "table": self._pg_table,
            "embedding_base_url": self._embed_base,
            "embedding_model": self._embed_model,
            "row_count": int(total),
            "global_scope_count": int(global_count),
        }
