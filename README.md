# beautiful-pi

Beautiful UI extensions and themes for [pi](https://github.com/badlogic/pi-mono),
the terminal coding agent.

```
                             ▄▄
█████▄ ▄████▄ ▄████▄ █████▄ ▄██▄▄▄
▄▄▄▄██ ██  ██ ██▄▄██ ██  ██ ▀██▀▀▀
██▄▄██ ██▄▄██ ██▄▄▄▄ ██  ██  ██▄▄▄
 ▀▀▀▀▀  ▀▀▀██  ▀▀▀▀▀ ▀▀  ▀▀   ▀▀▀▀
        ████▀
```

**Features:** animated startup banner, status footer with context usage + git state,
cohesive rail-styled chat layout, one-line tool output, session auto-naming,
OpenAI Codex usage monitor, and two Tokyo Night colour themes.

---

## Installation

### Prerequisites

- [pi](https://github.com/badlogic/pi-mono) — install it globally
- A [Nerd Font](https://www.nerdfonts.com/) installed and configured in your
  terminal (recommended). The extensions degrade gracefully with ASCII fallbacks.

### Install the package

#### From npm

```bash
pi install beautiful-pi
```

#### From source

```bash
git clone https://github.com/danielmr/beautiful-pi.git
cd beautiful-pi
pi install .
```

Then reload pi:

```
/reload
```

### Enable themes

Set a theme in pi:

```
/theme tokyo-night
```

Or from the settings file (`~/.pi/agent/settings.json`):

```json
{
  "theme": "tokyo-night"
}
```

Available themes: `tokyo-night`, `tokyo-night-nord`.

---

## Features

### Animated startup banner

On session start, beautiful-pi displays a fullscreen banner with:

- **Left column:** Large π ASCII art with per-character fade-in animation, plus
  agent info card (pi version, model, active theme).
- **Right column:** Resource listing — all loaded extensions, skills, and themes.

The banner auto-hides on first input.

```
                         (pi) CODING AGENT          ┌─── RESOURCES ───┐
           ░██           ┌─────────────────────┐    │ [Extensions]     │
              │          │ version   0.80.10    │    │   beautiful-pi   │
░████████  ░██           │ model     claude-..  │    ├─────────────────┤
░██    ░██ ░██           │ theme     Tokyo Night│    │ [Skills]         │
░██    ░██ ░██           └─────────────────────┘    │   omarchy, …     │
░███   ░██ ░██                                       ├─────────────────┤
░██░█████  ░██                                       │ [Themes]         │
░██                                                 │   tokyo-night    │
░██                                                 └──────────────────┘
```

**Toggle:** `showBanner` setting (default: `on`).

---

### Status footer

A two-line widget that replaces the default pi footer:

#### Above the editor — stats bar

```
π  claude-sonnet  (medium)  [████████░░░░] 45%  ↑12k ↓3k  $0.031  0:42  ✨ Add dark mode
┌───────────────────────────────────────────────────────────────────────────────┐
```

Shows model, thinking level, context usage (bar + percentage), token counts,
cost, session timer, and the session title.

#### Below the editor — cwd + git state + OpenAI quota

```
~/projects/my-project  ⎇ main ↑1 ↓2 +3 !2 ?1                75% 0:42h | 30% 2d
```

- Current directory (with `~` for home, smart truncation)
- Git branch, ahead/behind, staged/modified/untracked counts
- OpenAI Codex rate-limit usage (5h + 7d windows) — shown when using an OpenAI
  Codex model

**Toggle:** `showFooter` setting (default: `on`).

---

### Rail-styled chat messages

All message types render with a consistent left rail (`┃`) and controlled
indentation:

#### Agent messages

- **Text blocks:** no left rail, clean background (or default terminal bg)
- **Thinking blocks:** coloured `┃` rail with italic content (colour controlled
  by `thinkingRailColor` setting)
- **Error/stop reasons:** shown in `error` colour

#### User messages

- Coloured `┃` rail on the left (colour controlled by `userRailColor` setting)

#### Tool execution

When `toolsOneLine` is enabled (`on` by default), each tool call renders as a
single compact line:

```text
    ┃ spinner  cmd — npm install express
    ┃ ✓        Read  ~/config/app.ts:10–30
    ┃ ✓        Grep  "middleware"  src/  (*.ts)
    ┃ ✓        Edit  ~/config/app.ts
```

- Spinning dots during execution (disappears when done)
- Green `✓` on success, red `✕` on error
- Colour and dimness controlled by `toolRailColor` and `dimToolsText` settings
- Unregistered tools (MCP, web search, etc.) get the same treatment via a
  generic patch

#### Custom messages (web search results, skill output, etc.)

```text
    ┃ Web Search Results
    ┃ Title: Finding the answer
    ┃ URL: https://example.com
```

Colour controlled by `customMessageRailColor` and `dimCustomMessages` settings.

---

### Session auto-title

On first user input in a new session, beautiful-pi sends a lightweight LLM call
to generate a concise emoji title (e.g. `✨ Add dark mode toggle`). The title
appears in:

- The session selector sidebar
- The terminal tab title
- The stats bar (above editor)

Falls back to simple truncation if the LLM call fails. The feature is
configurable via `sessionTitle` setting (default: `on`).

---

### /beautiful-pi command

Opens a TUI settings panel where you can toggle all features and pick rail
colours:

```
╭───  beautiful-pi settings ───────────────────────────────╮
│                                                           │
│  > Banner                        on                       │
│    Footer                        on                       │
│    Session title                 on                       │
│    Tools one-line                on                       │
│    Indent level                  4                        │
│                                                           │
│    Agent rail color              accent                   │
│    User rail color               mdLink                   │
│    Thinking rail color           mdHeading                │
│    Dim thinking text             on                       │
│    Tools rail color              success                  │
│    Dim tools text                on                       │
│    Custom rail color             borderMuted              │
│    Dim custom messages           on                       │
│                                                           │
╰──  ↑↓ navigate  Space/Enter change  Esc close  ──────────╯
```

Changes persist to `~/.pi/agent/beautiful-pi.json`. Run `/reload` after
changing toggles or colours.

---

### Editor border

The editor gets a custom border treatment:

- Content lines prefixed with `❯`
- Bottom border shows a session timer in the right corner:
  ```
  └────────────────────────────────────────────────────────── ◷ 42m ─┘
  ```
- The top border is removed so the stats bar merges seamlessly into the editor

---

## Settings reference

All settings are stored in `~/.pi/agent/beautiful-pi.json`. Only values that
differ from defaults are persisted. Delete the file to reset everything.

| Setting | Type | Default | Description |
|---|---|---|---|
| `showBanner` | boolean | `true` | Show animated startup banner |
| `showFooter` | boolean | `true` | Show stats bar + footer |
| `sessionTitle` | boolean | `true` | Auto-generate session titles |
| `toolsOneLine` | boolean | `true` | Compact one-line tool output |
| `indentLevel` | integer | `4` | Rail indentation (spaces) |
| `agentRailColor` | string | `"accent"` | Agent thinking rail colour token |
| `userRailColor` | string | `"mdLink"` | User message rail colour token |
| `thinkingRailColor` | string | `"mdHeading"` | Thinking block rail colour token |
| `thinkingTextColor` | string | `"muted"` | Thinking text colour token |
| `dimThinkingText` | boolean | `true` | Dim thinking text |
| `toolRailColor` | string | `"success"` | Tool execution rail colour token |
| `dimToolsText` | boolean | `true` | Dim completed tool labels |
| `customMessageRailColor` | string | `"borderMuted"` | Custom message rail colour token |
| `dimCustomMessages` | boolean | `true` | Dim custom message text |

Colour tokens reference the active theme's semantic colour map. Available
tokens: `accent`, `border`, `borderAccent`, `borderMuted`, `muted`, `dim`,
`text`, `thinkingText`, `success`, `error`, `warning`, `syntaxKeyword`,
`syntaxFunction`, `syntaxString`, `syntaxType`, `mdHeading`, `mdLink`,
`mdCode`, `customMessageLabel`, `toolTitle`.

---

## Themes

### Tokyo Night

A faithful adaptation of the classic [Tokyo Night](https://github.com/folke/tokyonight.nvim)
colour palette for pi. Deep blue-grey background (`#1a1b26`) with vibrant accent
colours.

### Tokyo Night Nord

A hybrid theme that blends Tokyo Night's syntax colours with a Nord-like cooler
palette. Uses a slightly lighter accent set while keeping the same deep
background.

---

## Extension architecture

```
extensions/
├── index.ts                    # Entry point — wires all extensions
├── shared/
│   ├── icons.ts                # Nerd Fonts detection, icon sets, strWidth()
│   └── settings.ts             # Settings loader, safe colour helpers, tests
├── settings/
│   └── index.ts                # `/beautiful-pi` command (SettingsList TUI)
├── banner/
│   └── index.ts                # Startup banner (aboveEditor header)
├── footer/
│   ├── index.ts                # Stats bar + footer widgets
│   ├── borderless-top-editor.ts# Custom editor with ❯ prefix + timer
│   └── openai-usage.ts         # OpenAI Codex quota fetcher/parser
├── assistant-style/
│   └── index.ts                # Agent message rail style
├── user-style/
│   └── index.ts                # User message rail style
├── custom-message/
│   └── index.ts                # Custom message rail style
├── session-title/
│   └── index.ts                # Auto-title generation
└── tools-one-line/
    ├── index.ts                # Tools wire-up
    ├── shared.ts               # OneLine component, spinner, registerTool helpers
    ├── register-bash.ts        # Bash tool label
    ├── register-read.ts        # Read tool label
    ├── register-write.ts       # Write tool label
    ├── register-edit.ts        # Edit tool label
    ├── register-grep.ts        # Grep tool label
    ├── register-find.ts        # Find tool label
    ├── register-ls.ts          # Ls tool label
    └── register-generic.ts     # Generic tool rail patch (MCP, unregistered tools)
```

---

## Security

This project includes a pre-commit hook that scans staged changes for secrets
using [gitleaks](https://github.com/gitleaks/gitleaks). Set it up:

```bash
git config core.hooksPath .githooks
```

You can also run it manually:

```bash
npm run gitleaks:scan     # full repo scan
npm run gitleaks:staged   # scan staged changes only
```

---

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for workflow, conventions, and
contribution guidelines.

## License

MIT — see [LICENSE](./LICENSE).
