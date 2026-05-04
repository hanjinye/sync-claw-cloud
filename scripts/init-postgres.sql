\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;

CREATE SCHEMA IF NOT EXISTS __SYNC_SCHEMA__;

CREATE TABLE IF NOT EXISTS __SYNC_SCHEMA__.schema_meta (
  name text PRIMARY KEY,
  version integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO __SYNC_SCHEMA__.schema_meta (name, version)
VALUES ('core', 0)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS __SYNC_SCHEMA__.memories (
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

ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS text text;
ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS vector vector(2560);
ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'global';
ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS importance double precision;
ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS timestamp bigint;
ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS terminal text;
ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS client text;
ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS session_key text;
ALTER TABLE __SYNC_SCHEMA__.memories ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS memories_scope_timestamp_idx
  ON __SYNC_SCHEMA__.memories (scope, timestamp DESC);

CREATE INDEX IF NOT EXISTS memories_terminal_idx
  ON __SYNC_SCHEMA__.memories (terminal);

CREATE INDEX IF NOT EXISTS memories_client_idx
  ON __SYNC_SCHEMA__.memories (client);

CREATE INDEX IF NOT EXISTS memories_halfvec_cosine_idx
  ON __SYNC_SCHEMA__.memories
  USING hnsw ((vector::halfvec(2560)) halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS memories_bm25_idx
  ON __SYNC_SCHEMA__.memories
  USING bm25 (
    id,
    text,
    category,
    scope,
    terminal,
    client
  )
  WITH (key_field = 'id');

CREATE TABLE IF NOT EXISTS __SYNC_SCHEMA__.conversation_turns (
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

ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS participant text;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS question text;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS reply text;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS terminal text;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS client text;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS session_key text;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS channel_id text;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS conversation_id text;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS account_id text;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS user_timestamp bigint;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS assistant_timestamp bigint;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE __SYNC_SCHEMA__.conversation_turns ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS conversation_turns_session_idx
  ON __SYNC_SCHEMA__.conversation_turns (session_key);

CREATE INDEX IF NOT EXISTS conversation_turns_terminal_idx
  ON __SYNC_SCHEMA__.conversation_turns (terminal);

CREATE INDEX IF NOT EXISTS conversation_turns_participant_idx
  ON __SYNC_SCHEMA__.conversation_turns (participant);

CREATE INDEX IF NOT EXISTS conversation_turns_created_idx
  ON __SYNC_SCHEMA__.conversation_turns (created_at DESC);

CREATE INDEX IF NOT EXISTS conversation_turns_bm25_idx
  ON __SYNC_SCHEMA__.conversation_turns
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

CREATE TABLE IF NOT EXISTS __SYNC_SCHEMA__.profile_documents (
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

ALTER TABLE __SYNC_SCHEMA__.profile_documents ADD COLUMN IF NOT EXISTS doc_key text;
ALTER TABLE __SYNC_SCHEMA__.profile_documents ADD COLUMN IF NOT EXISTS logical_name text;
ALTER TABLE __SYNC_SCHEMA__.profile_documents ADD COLUMN IF NOT EXISTS source_path text;
ALTER TABLE __SYNC_SCHEMA__.profile_documents ADD COLUMN IF NOT EXISTS content text;
ALTER TABLE __SYNC_SCHEMA__.profile_documents ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE __SYNC_SCHEMA__.profile_documents ADD COLUMN IF NOT EXISTS terminal text;
ALTER TABLE __SYNC_SCHEMA__.profile_documents ADD COLUMN IF NOT EXISTS client text;
ALTER TABLE __SYNC_SCHEMA__.profile_documents ADD COLUMN IF NOT EXISTS source_mtime bigint;
ALTER TABLE __SYNC_SCHEMA__.profile_documents ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE __SYNC_SCHEMA__.profile_documents ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS profile_documents_doc_key_idx
  ON __SYNC_SCHEMA__.profile_documents (doc_key);

CREATE INDEX IF NOT EXISTS profile_documents_created_idx
  ON __SYNC_SCHEMA__.profile_documents (created_at DESC);

CREATE INDEX IF NOT EXISTS profile_documents_terminal_idx
  ON __SYNC_SCHEMA__.profile_documents (terminal);

CREATE INDEX IF NOT EXISTS profile_documents_hash_idx
  ON __SYNC_SCHEMA__.profile_documents (content_hash);

CREATE TABLE IF NOT EXISTS __SYNC_SCHEMA__.profile_sync_events (
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

ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS doc_key text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS logical_name text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS terminal text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS client text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS merge_strategy text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS local_action text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS pushed boolean NOT NULL DEFAULT false;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS has_conflict boolean NOT NULL DEFAULT false;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS remote_variant_count integer NOT NULL DEFAULT 0;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS merged_from_terminals jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS backup_path text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS target_path text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE __SYNC_SCHEMA__.profile_sync_events ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS profile_sync_events_created_idx
  ON __SYNC_SCHEMA__.profile_sync_events (created_at DESC);

CREATE INDEX IF NOT EXISTS profile_sync_events_doc_key_idx
  ON __SYNC_SCHEMA__.profile_sync_events (doc_key);

CREATE INDEX IF NOT EXISTS profile_sync_events_conflict_idx
  ON __SYNC_SCHEMA__.profile_sync_events (has_conflict, created_at DESC);

CREATE INDEX IF NOT EXISTS profile_sync_events_terminal_idx
  ON __SYNC_SCHEMA__.profile_sync_events (terminal, created_at DESC);

UPDATE __SYNC_SCHEMA__.schema_meta
SET version = 1, updated_at = now()
WHERE name = 'core';
