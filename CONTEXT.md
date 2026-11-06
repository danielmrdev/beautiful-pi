# CONTEXT.md — beautiful-pi

Glossary of domain terms for the beautiful-pi UI extension package.
This file pins down what things mean, not how they are built. Implementation
details live in the code.

## Status bars

- **Widget (stats-bar)** — the status block rendered above the editor: model,
  thinking level, context usage, session title, plus the `┌─…─┐` box top that
  merges with the editor's frame.
- **Footer** — the status line(s) rendered below the editor: cwd + git state
  on the left, quota usage on the right.
- **Segment** — a logical chunk of a status bar that may move to its own line
  in narrow mode. Widget: `model + context` and `session title`. Footer:
  `cwd + git` and `usage`.
- **Narrow mode** — a status bar renders on two lines instead of one because
  its segments no longer fit the terminal width. Triggered by **overflow**,
  never by a fixed width threshold.
- **Editor box** — the prompt editor is a bordered box at all times: `❯` on the
  first content line, `|` on every following content line, `| … |` around
  autocomplete rows, `├─── ↓ ───┤` as the autocomplete separator, and
  `└─…─┘` as the bottom frame. The widget's `┌─…─┐` closes the box on top.

## Herdr integration

- **Session name** — the display name Pi stores for the current session
  (`setSessionName`/`getSessionName`), shown in the session selector and as
  the widget's **session title** segment. It is mirrored to Herdr's
  `pi.session` terminal label.
- **Pane label** — the persistent name the `beautiful-herdr` layout shows in
  its pane header. Set with `hc label $HC_TERMINAL_ID pi.session=<name>`;
  `bh-pane` prioritizes this label over the terminal title. Legacy Herdr
  sessions retain a `herdr pane rename` fallback.
- **Terminal title** — the live title set by the terminal program; Pi writes
  it with `ctx.ui.setTitle()`, and Herdr exposes it as `PaneInfo.title`. It is
  distinct from the `pi.session` label used for session names.

## Quota usage

- **Window** — a time-bounded quota bucket with a cap. Codex: 5-hour and
  7-day. Opencode: rolling 5h, weekly 7d, monthly 30d.
- **Tier** — one of opencode's three windows (rolling / weekly / monthly),
  each with its own dollar cap.
- **Expected usage** — the percentage of a window's cap that would be consumed
  at the current moment if spending were perfectly linear across the window.
- **Over-budget** — actual usage percentage exceeds expected usage for the
  same window.
