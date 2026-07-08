/**
 * Nerd Fonts detection + icon/separator sets for pi extensions.
 * ASCII fallbacks for terminals without Nerd Fonts.
 */

// ── ANSI strip ──────────────────────────────────────────────────────────────────

const _ANSI_RE = /\x1b\[[0-9;]*m/g;

// ── Character display width ──────────────────────────────────────────────────
//
// Terminals render characters at 1 or 2 cell widths:
//   - ASCII / Latin / most scripts → 1 cell
//   - CJK, Emoji, some symbols     → 2 cells
//   - Nerd Fonts BMP PUA (E000–F8FF) → 1 or 2 cells depending on terminal
//   - Nerd Fonts Supplementary PUA-A (F0000–FFFFF, new MDI in NF v3) → 2 cells
//
// Ghostty (and some others) renders BMP PUA NF icons as 2-cell wide.
// Set NERD_FONTS_DOUBLE_WIDTH=0 to force 1-cell, =1 to force 2-cell.

function _nfIconWidth(): number {
  const env = process.env["NERD_FONTS_DOUBLE_WIDTH"];
  if (env === "1") return 2;
  // Default: 1-cell wide for BMP PUA NF icons.
  // Set NERD_FONTS_DOUBLE_WIDTH=1 if your terminal renders them as 2-wide.
  return 1;
}

function _cpWidth(cp: number): number {
  if (cp === 0) return 0;
  // C0 / C1 control characters
  if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) return 0;
  // Nerd Fonts BMP Private Use Area
  if (cp >= 0xE000 && cp <= 0xF8FF) return _nfIconWidth();
  // Nerd Fonts Supplementary PUA-A (new MDI icons in NF v3)
  if (cp >= 0xF0000 && cp <= 0xFFFFF) return 2;
  // East Asian Wide / Fullwidth (common CJK ranges)
  if (
    (cp >= 0x1100 && cp <= 0x115F)  ||
    (cp >= 0x2E80 && cp <= 0x303E)  ||
    (cp >= 0x3041 && cp <= 0x33FF)  ||
    (cp >= 0xFF01 && cp <= 0xFF60)  ||
    (cp >= 0xFFE0 && cp <= 0xFFE6)  ||
    (cp >= 0x1F300 && cp <= 0x1FAFF)   // Emoji + misc symbols
  ) return 2;
  return 1;
}

/**
 * Visual display width of a string in terminal cells.
 * Strips ANSI colour codes, handles Nerd Fonts icons, wide CJK, surrogates.
 */
export function strWidth(str: string): number {
  let w = 0;
  for (const ch of str.replace(_ANSI_RE, "")) {
    w += _cpWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

// ── Detection ─────────────────────────────────────────────────────────────────

export function hasNerdFonts(): boolean {
  if (process.env["POWERLINE_NERD_FONTS"] === "1") return true;
  if (process.env["POWERLINE_NERD_FONTS"] === "0") return false;

  // Terminal-specific env vars (survive tmux)
  if (process.env["GHOSTTY_RESOURCES_DIR"]) return true;
  if (process.env["ALACRITTY_WINDOW_ID"]) return true;
  if (process.env["KITTY_WINDOW_ID"]) return true;
  if (process.env["VSCODE_INJECTION"]) return true;

  const term = (process.env["TERM_PROGRAM"] ?? "").toLowerCase();
  return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some(t => term.includes(t));
}

// ── Icon sets ─────────────────────────────────────────────────────────────────

export interface IconSet {
  pi: string;
  folder: string;
  git: string;
  branch: string;
  time: string;
  cost: string;
  input: string;
  output: string;
  cache: string;
  ahead: string;
  behind: string;
  staged: string;
  modified: string;
  untracked: string;
}

export const NERD_ICONS: IconSet = {
  pi:       "\uE22C",   // nf-oct-pi
  folder:   "\uF115",   // nf-fa-folder_open
  git:      "\uF1D3",   // nf-fa-git
  branch:   "\uF418",   // nf-oct-git_branch
  time:     "\uF017",   // nf-fa-clock_o
  cost:     "\uF155",   // nf-fa-dollar
  input:    "\uF062",   // nf-fa-arrow_up       ↑ (tokens in)
  output:   "\uF063",   // nf-fa-arrow_down     ↓ (tokens out)
  cache:    "\uF1C0",   // nf-fa-database
  ahead:    "\u21E1",   // ⇡  (p10k standard)
  behind:   "\u21E3",   // ⇣  (p10k standard)
  staged:   "+",         // +  (p10k standard)
  modified: "!",         // !  (p10k standard)
  untracked:"?",         // ?  (p10k standard)
};

export const GITHUB_ICON  = "\uF113"; // nf-fa-github_alt (same as p10k VCS_GIT_GITHUB_ICON)
export const GITHUB_ICON_ASCII = "gh";

export const ASCII_ICONS: IconSet = {
  pi:     "\u03C0",    // π Greek small letter pi (standard 1-cell)
  folder: "",          // nothing — path already starts with ~/
  git:    "",          // nothing — just show branch
  branch: "\u2387",    // ⎇
  time:   "\u25F7",    // ◷
  cost:   "$",
  input:  "\u2191",    // ↑
  output: "\u2192",    // ↓ (reuse arrow)
  cache:  "R",
  ahead:    "\u21E1",  // ⇡
  behind:   "\u21E3",  // ⇣
  staged:   "\u271A",  // ✚
  modified: "!",
  untracked:"?",
};

export function getIcons(): IconSet {
  return hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
}

// ── Thinking level ────────────────────────────────────────────────────────────

export const BRAIN_ICON = "\uEE9C"; // brain icon

const THINKING_NERD: Record<string, string> = {
  none:    `${BRAIN_ICON} off`,
  off:     `${BRAIN_ICON} off`,
  minimal: `${BRAIN_ICON} min`,
  low:     `${BRAIN_ICON} low`,
  medium:  `${BRAIN_ICON} med`,
  high:    `${BRAIN_ICON} high`,
};

const THINKING_ASCII: Record<string, string> = {
  none:    "off",
  off:     "off",
  minimal: "min",
  low:     "low",
  medium:  "med",
  high:    "high",
};

export function getThinkingText(level: string): string | undefined {
  const map = hasNerdFonts() ? THINKING_NERD : THINKING_ASCII;
  return map[level];
}
