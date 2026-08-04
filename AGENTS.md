# AGENTS.md — beautiful-pi contributor guide for AI coding agents

This file is for AI coding agents (Pi, Cursor, Copilot, etc.) contributing to
beautiful-pi. It describes project structure, conventions, and patterns.

## What this project is

`beautiful-pi` is a **pi package** — UI extensions and themes for the
[`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono) CLI
(aka pi). It improves pi's terminal UI with an animated banner, status footer,
rail-styled chat messages, one-line tool output, and colour themes.

## Repository layout

```
beautiful-pi/
├── package.json                  # pi manifest + package metadata
├── extensions/
│   ├── index.ts                  # entry point — wires all sub-extensions
│   ├── shared/
│   │   ├── icons.ts              # Nerd Fonts detection, icon sets, strWidth
│   │   └── settings.ts           # settings loader, safeFg/safeBg helpers
│   ├── settings/
│   │   └── index.ts              # /beautiful-pi command (SettingsList TUI)
│   ├── banner/
│   │   └── index.ts              # startup banner widget
│   ├── footer/
│   │   ├── index.ts              # stats bar + footer widgets
│   │   ├── borderless-top-editor.ts  # custom editor with ❯ prefix + timer
│   │   └── openai-usage.ts       # OpenAI Codex quota fetcher/parser
│   ├── assistant-style/
│   │   └── index.ts              # patches AssistantMessageComponent rail
│   ├── user-style/
│   │   └── index.ts              # patches UserMessageComponent rail
│   ├── custom-message/
│   │   └── index.ts              # patches CustomMessageComponent rail
│   ├── session-title/
│   │   └── index.ts              # auto-title from first user message
│   └── tools-one-line/
│       ├── index.ts              # wires all tool registrations
│       ├── shared.ts             # OneLine, renderLine, registerTool helpers
│       ├── register-bash.ts      # label for bash tool
│       ├── register-read.ts      # label for read tool
│       ├── register-write.ts     # label for write tool
│       ├── register-edit.ts      # label for edit tool
│       ├── register-grep.ts      # label for grep tool
│       ├── register-find.ts      # label for find tool
│       ├── register-ls.ts        # label for ls tool
│       └── register-generic.ts   # fallback rail for unregistered tools
├── themes/
│   ├── tokyo-night.json
│   └── tokyo-night-nord.json
└── .githooks/
    └── pre-commit                # gitleaks secret scan
```

## Extension folder convention

Each feature lives in its own subdirectory under `extensions/`:

```
extensions/<feature>/
├── index.ts          # required — default export (pi: ExtensionAPI) => void
└── *.ts              # helpers imported by index.ts
```

- `extensions/index.ts` is the single entry point — it imports and calls each
  feature's default export in order.
- `extensions/shared/` is shared utilities, not a feature.

## extension entry point pattern

```ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx: ExtensionContext) => {
    // register widgets, setHeader, setFooter, setEditorComponent
    // check ctx.hasUI before using ctx.ui.*
  });

  pi.on("input", (event, ctx) => {
    // react to user input (e.g. hide banner, set title)
  });

  pi.on("session_shutdown", () => {
    // clean up timers, intervals
  });
}
```

## Key architectural patterns

### Settings system

Settings live in `extensions/shared/settings.ts`. They load from:
1. `extensions/settings/defaults.json` (shipped defaults)
2. `~/.pi/agent/beautiful-pi.json` (user overrides, only diff stored)

Use `loadSettings()` to read, `saveSettings()` to write. Use `safeFg(theme, token, fallback, text)` for colouring — it handles missing theme tokens gracefully.

Settings are cached for 500ms. Call `invalidateSettingsCache()` after external writes.

### Rail colour system

All chat message types (agent, user, custom, tools) render with a `┃` rail.
Each has its own colour setting and optional dimming. When adding a new rail
type:

1. Add a `railColor` + `dimText` setting in `settings/defaults.json`
2. Add the `BeautifulPiSettings` field in `settings.ts`
3. Wire it into the `SettingsList` in `settings/index.ts`
4. Use `safeFg(theme, settings.myRailColor, "fallback", text)` in the component

### Theme colour tokens

Themes define semantic colour tokens. Standard tokens available:

`accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`,
`warning`, `muted`, `dim`, `text`, `thinkingText`, `selectedBg`,
`userMessageBg`, `mdHeading`, `mdCode`, `syntaxKeyword`, `syntaxFunction`,
`syntaxString`, `syntaxNumber`, `syntaxType`, `toolDiffAdded`,
`toolDiffRemoved`, `bashMode`, `thinkingOff`–`thinkingXhigh`, etc.

Always provide a fallback colour when using `safeFg()` — themes may not define
every token.

### Nerd Fonts fallback pattern

Always degrade gracefully:

```ts
import { hasNerdFonts, getIcons } from "../shared/icons.ts";

const icons = getIcons(); // returns NERD_ICONS or ASCII_ICONS
const nf = hasNerdFonts(); // boolean
```

`strWidth(str)` handles ANSI escapes + wide CJK + Nerd Fonts PUA widths.

### /reload safety

Extensions must survive `/reload`. Patterns:

- **Symbol-based globals:** Use `Symbol.for("beautiful-pi:key")` on
  `globalThis` to persist state across reloads (animation frame, session start).
- **`instanceof` restoration:** Save original prototype methods once
  (e.g. `proto.__beautifulPiOriginal = proto.method`), restore and re-apply on
  reload.
- **Event rebinding:** `pi.on("session_start", ...)` re-registers every reload;
  guard against double-registration where needed.

### Dead extension problem

If an extension is removed while pi is running (`/reload` after removing the
extension directory), its state persists because:
- UI widgets/footers/headers registered by ID must be explicitly unregistered
- Prototype patches remain on the class
- Shared Symbols remain on globalThis

When modifying an existing extension, consider cleanup. Not critical for the
current feature set since all are loaded/unloaded together.

## Tool one-line system

`tools-one-line/` intercepts pi's built-in tool rendering via `registerTool()`:

```ts
registerTool(pi, "bash", (args, cwd, theme) =>
  theme.fg("bashMode", compact(args.command).slice(0, 160))
);
```

The `renderCall` function returns a `OneLine` instance — a compact inline
component with:
- Spinner during execution (when `isAgentActive` is true)
- Green `✓` / red `✕` on completion
- Intent line above (grey), label line below
- Timer-driven invalidation for spinner animation

The `register-generic.ts` patch catches tools not explicitly registered (MCP,
web search, etc.) by patching `ToolExecutionComponent.prototype` with the same
rail style.

## Pre-commit security hook

`.githooks/pre-commit` runs `gitleaks protect --staged`. Enable with:

```bash
git config core.hooksPath .githooks
```

Run manually: `npm run gitleaks:scan` or `npm run gitleaks:staged`.

## Build and runtime

- **No build step.** Pi loads `.ts` files directly at runtime.
- Use `require("node:fs")` for Node built-ins inside `.ts` files (CommonJS).
- Import pi types from `@mariozechner/pi-coding-agent`.
- Always check `ctx.hasUI` before using `ctx.ui.*` — they throw in print/RPC
  mode.
- The package manager's `pi install` command resolves local paths, npm packages,
  and git repos.

## Commit conventions

Follow conventional commits:
- `feat: ...` — new feature
- `fix: ...` — bug fix
- `chore: ...` — tooling, config, housekeeping
- `docs: ...` — documentation
- `refactor: ...` — code restructuring

Use present tense, lowercase, no period. Describe what the commit does, not
why (that's for the PR description).

## Settings reference (for code generation)

Default values in `extensions/settings/defaults.json`:

| Setting | Type | Default | Purpose |
|---|---|---|---|
| showBanner | bool | true | Animated startup banner |
| showFooter | bool | true | Stats bar + footer |
| sessionTitle | bool | true | Auto-title from LLM |
| toolsOneLine | bool | true | Compact tool output |
| indentLevel | int | 4 | Rail indentation |
| agentRailColor | string | "accent" | Agent thinking rail |
| userRailColor | string | "mdLink" | User message rail |
| thinkingRailColor | string | "mdHeading" | Thinking block rail |
| thinkingTextColor | string | "muted" | Thinking text colour |
| dimThinkingText | bool | true | Dim thinking text |
| toolRailColor | string | "success" | Tool execution rail |
| dimToolsText | bool | true | Dim tool labels |
| customMessageRailColor | string | "borderMuted" | Custom msg rail |
| dimCustomMessages | bool | true | Dim custom msg text |

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
