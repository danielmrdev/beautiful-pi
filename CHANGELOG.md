# Changelog

All notable changes to beautiful-pi are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-11-09

### Added

- Add `verbosity` setting (`high`/`medium`/`low`) controlling thinking visibility and tool output.
- Render `ask_user_question` as a beautiful-pi tool with rail, indentation, spinner/✓ and Q&A output.

### Changed

- Low verbosity suppresses tool output and thinking turns, showing a live aggregate line during the agent turn and a one-line tool count at the end.

## [0.6.0] - 2026-11-09

### Changed

- Vendor `/btw` inside beautiful-pi and remove its external npm dependency.
- Show `/btw` prompt and answer in a centered dialog instead of a full-width panel.
- Style `/btw` prompt and answer with user/agent rails and role-specific backgrounds, without a dialog frame.
- Vendor `ask_user_question` inside beautiful-pi and remove its external npm dependency.
- Bridge `ask_user_question` blocked state to Herdr's attention indicator (pane shows "blocked" while a questionnaire is open).

## [0.5.2] - 2026-11-07

### Fixed

- Load `@pi-archimedes/sudo` through a package-local adapter so `sudo_exec` registers in local and symlink installs.

## [0.5.1] - 2026-11-06

### Fixed

- Sync Pi session names to herdr-app pane labels, including sessions resumed through `/resume`, `pi -c`, and `pi --session`.

## [0.5.0] - 2026-11-05

### Added

- Add a `/bpi` toggle to hide provider quota usage independently from the rest of the footer.

### Fixed

- Apply quota visibility changes to the active footer immediately and skip quota requests while hidden.

## [0.4.0] - 2026-11-05

### Added

- Bundle `@pi-archimedes/sudo@2.13.0` with human-confirmed `sudo_exec`, a masked password prompt, and a guard against interactive `sudo` through the built-in `bash` tool.

## [0.3.2] - 2026-11-02

### Changed

- Support Pi 1.5.x; update development checks to Pi 1.5.0 and widen Pi peer ranges to `>=1.2.0 <1.6.0`.
- Refresh bundled integrations: Plannotator 0.28.46, pi-subagents 0.22.1, ask-user-question, BTW and todo 2.15.0, and Blackhole 0.5.16.
- Update TypeScript to 7.0.2.

## [0.3.1] - 2026-11-02

### Fixed

- Preserve provider-supplied tool and system declarations when replaying OpenAI Codex native checkpoints, so tools remain available after compaction.

## [0.3.0] - 2026-10-22

### Added

- Bundle `@juicesharp/rpiv-todo@2.13.9` with a persistent task panel and `/todos` command.

### Changed

- Support Pi 1.2.0–1.4.x; widen all Pi peer ranges to `>=1.2.0 <1.5.0`.
- Update Hypa to 1.2.0, Plannotator to 0.28.26, and Blackhole to 0.5.15.
- Plannotator 0.28.26 adds Pi session review events and a moving checklist widget.

### Fixed

- Blackhole 0.5.14 preserves Pi's later safe split-turn boundary with `tailBehavior: "minimal"` on long single-turn branches.

## [0.2.0] - 2026-10-13

### Changed

- Support Pi 1.2.0–1.2.x; peer range is now `>=1.2.0 <1.3.0`.
  Pi 1.1's current MCP/codemode dependency combination fails compaction smoke.
- Refresh bundled integrations: Codex compaction 0.1.6, Hypa 1.0.8,
  Plannotator 0.28.18, pi-subagents 0.22.0, ask-user-question and BTW 2.13.8,
  and Blackhole 0.5.12.
- Plannotator Inbox can connect detected agents when `plannotator inbox` runs;
  it asks before writing agent instruction notes.
- pi-subagents 0.22.0 changes default `smart` background completion delivery;
  use `group` join mode for one notification per parent-turn batch.
- Pin Pi 1.2.0 for development checks and update `tsx` to 4.23.15.

### Fixed

- Hypa 1.0.8 fixes panes freezing when another window or cube peer views them,
  including viewers with different window sizes.
- pi-subagents 0.22.0 cleans up widget and group-join timers on reload and
  session replacement; 0.21.0 also restores cloned mention history on Pi 1.x.
- Plannotator 0.28.17 fixes a Pi crash when a review tab stays open across
  `/reload` or session switch.

### Removed

- Remove `pi-rtk-optimizer`; its Pi peer range excludes Pi 1.x and Hypa covers
  overlapping command rewriting and output compression.

## [0.1.8] - 2026-10-01

### Changed

- Extend verified Pi compatibility through 0.99.2; peer range is now
  `>=0.85.1 <0.99.3`.

## [0.1.7] - 2026-10-01

### Changed

- Extend Pi compatibility through 0.99.1; peer range is now
  `>=0.85.1 <0.99.2`.
- Update Plannotator to 0.27.24, ask-user-question and BTW to 2.12.0, and
  Blackhole to 0.5.10.
- Plannotator now persists viewed-file progress by default; disable it with
  `PLANNOTATOR_REVIEW_PROGRESS=0` or `reviewProgress: false` in its config.

## [0.1.6] - 2026-09-25

### Changed

- Usage pace bars now mirror the context indicator: `┄` dim track, `━` consumed
  cells in accent (warning over pace, error when exhausted), and a small `·`
  (accent) for the ideal linear limit.

### Fixed

- Fetch OpenCode Go usage from the Zen `/zen/go/v1/usage` API with the provider
  key configured in pi. The previous opencode.ai dashboard scrape broke when
  the console moved to a client-rendered SPA.
- Drop the unused `opencodeGoWorkspaceId` and `opencodeGoAuthCookie` settings
  and the settings TUI Credentials tab.

## [0.1.5] - 2026-09-25

### Changed

- Updated `pi-blackhole` to 0.5.8, `@hypabolic/pi-hypa` to 0.1.15,
  `@plannotator/pi-extension` to 0.27.20, and
  `@juicesharp/rpiv-ask-user-question` to 2.11.0.
- Documented the Pi 0.87 `/mention-clone` history limitation in
  `@tintinweb/pi-subagents` 0.19.0.
- Document Pi's active `reserveTokens` compaction threshold and linked-checkout
  dependency updates.

### Fixed

- Route managed Codex accounts (`openai-codex-N`) through native OpenAI
  compaction while preserving account-specific credentials and checkpoints;
  block replay across accounts.
- Load Codex compaction and Blackhole from beautiful-pi's pinned dependencies,
  not stale shared npm siblings; reject mismatched versions instead of silently
  using the wrong engine.

## [0.1.4] — 2026-09-23

### Changed

- Replaced the block-based context progress bar with a subtler hairline indicator.

## [0.1.3] — 2026-09-22

### Changed

- Updated the banner and status icon from `π` to `βπ` to identify beautiful-pi.

## [0.1.2] — 2026-09-22

### Changed

- The above-editor stats widget now displays `xhigh` and `max` thinking levels,
  and preserves unknown future levels instead of hiding them.

## [0.1.1] — 2026-09-22

### Changed

- Declared support for Pi 0.85.x–0.87.x and updated the peer range to
  `>=0.85.1 <0.88.0`.
- Upgraded the official `pi-blackhole` integration from 0.5.6 to 0.5.7 for
  Pi 0.87-compatible worker and inline-compaction fixes while preserving
  Codex provider coordination.
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

- The startup banner now shows the b-pi version between the Pi version and the
  active model.
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

### Fixed

- The smoke test now packs and installs the current package version instead of
  relying on a hardcoded old tarball filename.

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
