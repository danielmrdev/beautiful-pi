/**
 * Nerd Fonts detection + icon/separator sets for pi extensions.
 * ASCII fallbacks for terminals without Nerd Fonts.
 */

// ── Detection ─────────────────────────────────────────────────────────────────

export function hasNerdFonts(): boolean {
  if (process.env["POWERLINE_NERD_FONTS"] === "1") return true;
  if (process.env["POWERLINE_NERD_FONTS"] === "0") return false;

  // Ghostty env var survives into tmux
  if (process.env["GHOSTTY_RESOURCES_DIR"]) return true;

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
}

export const NERD_ICONS: IconSet = {
  pi:     "\uE22C",   // nf-oct-pi
  folder: "\uF115",   // nf-fa-folder_open
  git:    "\uF1D3",   // nf-fa-git
  branch: "\uE0A0",   // nf-pl-branch (p10k standard)
  time:   "\uF017",   // nf-fa-clock_o
  cost:   "\uF155",   // nf-fa-dollar
  input:  "\uF090",   // nf-fa-sign_in
  output: "\uF08B",   // nf-fa-sign_out
  cache:  "\uF1C0",   // nf-fa-database
};

export const GITHUB_ICON  = "\uF09B"; // nf-fa-github
export const GITHUB_ICON_ASCII = "gh";

export const ASCII_ICONS: IconSet = {
  pi:     "\u{1D6D1}", // 𝛑 mathematical bold small pi
  folder: "",          // nothing — path already starts with ~/
  git:    "",          // nothing — just show branch
  branch: "\u2387",    // ⎇
  time:   "\u25F7",    // ◷
  cost:   "$",
  input:  "\u2191",    // ↑
  output: "\u2192",    // ↓ (reuse arrow)
  cache:  "R",
};

export function getIcons(): IconSet {
  return hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
}

// ── Thinking level ────────────────────────────────────────────────────────────

export const BRAIN_ICON = "\uF5DC"; // nf-mdi-brain (U+F5DC, BMP PUA — correcto)

const THINKING_NERD: Record<string, string> = {
  low:    "low",
  medium: "med",
  high:   "high",
};

const THINKING_ASCII: Record<string, string> = {
  low:    "low",
  medium: "med",
  high:   "high",
};

export function getThinkingText(level: string): string | undefined {
  const map = hasNerdFonts() ? THINKING_NERD : THINKING_ASCII;
  return map[level];
}
