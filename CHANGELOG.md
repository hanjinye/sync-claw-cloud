# Changelog

This repository should currently be treated as an initial source release, not a long published release train.

## Unreleased

- Renamed the plugin/runtime identity to `sync-claw-cloud`
- Switched the primary backend to PostgreSQL
- Added PostgreSQL configuration loading from environment variables
- Added PostgreSQL bootstrap scripts
- Added `halfvec` HNSW support for 2560-dimension embeddings with full-vector rerank
- Simplified repository structure and removed non-essential docs/examples/skills
- Added source-install documentation for OpenClaw integration

## 0.1.0

Initial repository baseline for `sync-claw-cloud`.

Scope of the initial baseline:

- Forked/adapted from the original LanceDB-based OpenClaw memory implementation
- Reframed as a PostgreSQL-first memory plugin for OpenClaw
- Kept LanceDB code in the repository as the original reference path
- Added the `sync-claw-cloud` CLI namespace and plugin id
