# Changelog

All notable changes to beautiful-pi are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/codex account` command surface: add, authenticate, log out, remove, switch,
  inspect, and migrate Codex subscriptions on top of Pi's OAuth credential store.
- Provider adapter registry with a Codex adapter — the seam for future
  providers (e.g. opencode-go) to reuse the account surface.
- Automatic migration of legacy `pi-multi-pass` configuration (global and
  project) into the `accounts` namespace of `~/.pi/agent/beautiful-pi.json`,
  with a backup before the legacy file is consumed and safe-to-rerun semantics.
- Trusted project-level account restriction via `allowedCredentialIds` in
  `.pi/beautiful-pi.json`.

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
