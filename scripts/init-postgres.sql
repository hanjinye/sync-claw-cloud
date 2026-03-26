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

CREATE INDEX IF NOT EXISTS conversation_turns_session_idx
  ON sync_claw_cloud.conversation_turns (session_key);

CREATE INDEX IF NOT EXISTS conversation_turns_terminal_idx
  ON sync_claw_cloud.conversation_turns (terminal);

CREATE INDEX IF NOT EXISTS conversation_turns_participant_idx
  ON sync_claw_cloud.conversation_turns (participant);

CREATE INDEX IF NOT EXISTS conversation_turns_created_idx
  ON sync_claw_cloud.conversation_turns (created_at DESC);

CREATE INDEX IF NOT EXISTS conversation_turns_bm25_idx
  ON sync_claw_cloud.conversation_turns
  USING bm25 (
    id,
    participant,
    question,
    reply,
    terminal,
    client,
    session_key
  )
  WITH (key_field = 'id');

CREATE TABLE IF NOT EXISTS sync_claw_cloud.profile_documents (
  id bigserial PRIMARY KEY,
  doc_key text NOT NULL,
  logical_name text NOT NULL,
  source_path text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  terminal text,
  client text,
  source_mtime bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profile_documents_doc_key_idx
  ON sync_claw_cloud.profile_documents (doc_key);

CREATE INDEX IF NOT EXISTS profile_documents_created_idx
  ON sync_claw_cloud.profile_documents (created_at DESC);

CREATE INDEX IF NOT EXISTS profile_documents_terminal_idx
  ON sync_claw_cloud.profile_documents (terminal);

CREATE INDEX IF NOT EXISTS profile_documents_hash_idx
  ON sync_claw_cloud.profile_documents (content_hash);

CREATE TABLE IF NOT EXISTS sync_claw_cloud.profile_sync_events (
  id bigserial PRIMARY KEY,
  doc_key text NOT NULL,
  logical_name text NOT NULL,
  terminal text,
  client text,
  source text,
  merge_strategy text,
  local_action text NOT NULL,
  pushed boolean NOT NULL DEFAULT false,
  has_conflict boolean NOT NULL DEFAULT false,
  remote_variant_count integer NOT NULL DEFAULT 0,
  merged_from_terminals jsonb NOT NULL DEFAULT '[]'::jsonb,
  backup_path text,
  target_path text,
  content_hash text,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profile_sync_events_created_idx
  ON sync_claw_cloud.profile_sync_events (created_at DESC);

CREATE INDEX IF NOT EXISTS profile_sync_events_doc_key_idx
  ON sync_claw_cloud.profile_sync_events (doc_key);

CREATE INDEX IF NOT EXISTS profile_sync_events_conflict_idx
  ON sync_claw_cloud.profile_sync_events (has_conflict, created_at DESC);

CREATE INDEX IF NOT EXISTS profile_sync_events_terminal_idx
  ON sync_claw_cloud.profile_sync_events (terminal, created_at DESC);
