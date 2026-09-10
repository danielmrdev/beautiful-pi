# Changelog

All notable changes to beautiful-pi are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Updated the curated third-party integrations to the latest exact releases:
  `@ogulcancelik/pi-codex-compaction` 0.1.5, `@hypabolic/pi-hypa` 0.1.14,
  `@plannotator/pi-extension` 0.27.13, `@tintinweb/pi-subagents` 0.19.0,
  `@juicesharp/rpiv-ask-user-question` 2.9.0, and
  `@juicesharp/rpiv-btw` 2.9.0.
- Replaced the temporary `pi-blackhole` fork with the official 0.5.2 release,
  which includes the provider-skip capability used by Codex compaction
  coordination. Blackhole's new context-window-aware default compaction curve
  now applies to sessions without an explicit threshold.
- The compaction coordinator now warns when a project-local Blackhole config
  overrides `skipForProviders` without a compatible `openai-codex` entry.

### Added

- `/codex` argument autocomplete: typing `/codex ` shows sections, subcommands,
  and existing account/pool/chain/preset refs in the editor dropdown.
- `/codex account` command surface: add, authenticate, log out, remove, switch,
  inspect, and migrate Codex subscriptions on top of Pi's OAuth credential store.
- Provider adapter registry with a Codex adapter — the seam for future
  providers (e.g. opencode-go) to reuse the account surface.
- Automatic migration of legacy `pi-multi-pass` configuration (global and
  project) into the `accounts` namespace of `~/.pi/agent/beautiful-pi.json`,
  with a backup before the legacy file is consumed and safe-to-rerun semantics.
- Trusted project-level account restriction via `allowedCredentialIds` in
  `.pi/beautiful-pi.json`.
- `/codex pool` command surface: create, list, inspect, enable, disable, delete,
  add/remove members, and round-robin `use` for Codex pools.
- Codex pool rotation with eligibility checks (auth status, cooldowns, project
  restrictions) and automatic rate-limit failover: on a Codex 429/quota error
  the failed account is marked cooling down and attempted-for-this-request, the
  model switches to the pool's next eligible member, and the interrupted
  request is re-sent. Each account is attempted at most once per request;
  non-rate-limit errors are never touched.

## [0.1.0] — 2026-07-17

### Added

- Animated startup banner with π ASCII art and session info panel
- Status footer with token usage, git state, and context progress
- Rail-styled chat layout for agent, user, custom, and tool messages
- One-line compact tool output with spinner
- Session auto-naming from first user message
- `/beautiful-pi` command settings panel
- OpenAI Codex usage monitor
- Tokyo Night and Tokyo Night Nord colour themes
