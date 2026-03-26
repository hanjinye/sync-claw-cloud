\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;

CREATE SCHEMA IF NOT EXISTS sync_claw_cloud;

CREATE TABLE IF NOT EXISTS sync_claw_cloud.memories (
  id text PRIMARY KEY,
  text text NOT NULL,
  vector vector(2560) NOT NULL,
  category text NOT NULL,
  scope text NOT NULL DEFAULT 'global',
  importance double precision NOT NULL,
  timestamp bigint NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  terminal text,
  client text,
  session_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memories_scope_timestamp_idx
  ON sync_claw_cloud.memories (scope, timestamp DESC);

CREATE INDEX IF NOT EXISTS memories_terminal_idx
  ON sync_claw_cloud.memories (terminal);

CREATE INDEX IF NOT EXISTS memories_client_idx
  ON sync_claw_cloud.memories (client);

CREATE INDEX IF NOT EXISTS memories_halfvec_cosine_idx
  ON sync_claw_cloud.memories
  USING hnsw ((vector::halfvec(2560)) halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS memories_bm25_idx
  ON sync_claw_cloud.memories
  USING bm25 (
    id,
    text,
    category,
    scope,
    terminal,
    client
  )
  WITH (key_field = 'id');
