/**
 * Pi status bars:
 *
 * ABOVE EDITOR (widget):
 *   π  model • thinking  [████░░░░░░░░] 45%  ↑12k ↓3k  $0.031  0:42
 *
 * FOOTER (below editor):
 *   ~/projects/my-project  ⎇ main ↑2 ↓1 +3 !2 ?1
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getIcons, getThinkingText, GITHUB_ICON, GITHUB_ICON_ASCII, hasNerdFonts } from "./icons.ts";

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleWidth(str: string): number {
  // Array.from iterates code points, not code units — handles surrogate pairs (e.g. 𝛑 U+1D6D1)
  return Array.from(str.replace(ANSI_RE, "")).length;
}

function truncateToWidth(str: string, maxW: number): string {
  let w = 0;
  let inEsc = false;
  let result = "";
  for (const ch of str) {
    if (ch === "\x1b") { inEsc = true; result += ch; continue; }
    if (inEsc) { result += ch; if (/[a-zA-Z]/.test(ch)) inEsc = false; continue; }
    if (w >= maxW) break;
    result += ch;
    w++;
  }
  return result;
}

// ── Git state ─────────────────────────────────────────────────────────────────

interface GitState {
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  isGitHub: boolean;
}

function parseGitStatus(output: string): GitState {
  const lines = output.split("\n");
  let branch = "";
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let modified = 0;
  let untracked = 0;

  for (const line of lines) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
      if (branch === "(detached)") branch = "HEAD";
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { ahead = parseInt(m[1]!); behind = parseInt(m[2]!); }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.split(" ")[1] ?? "..";
      const x = xy[0] ?? "."; // index / staged
      const y = xy[1] ?? "."; // worktree / unstaged
      if (x !== "." && x !== "?") staged++;
      if (y !== ".") modified++;
    } else if (line.startsWith("? ")) {
      untracked++;
    }
  }

  return { branch, ahead, behind, staged, modified, untracked, isGitHub: false };
}

// ── CWD formatting ────────────────────────────────────────────────────────────

function formatCwd(cwd: string, maxLen: number, theme: any): { text: string; width: number } {
  const home = process.env["HOME"] ?? "";
  const display = home ? cwd.replace(home, "~") : cwd;
  const segments = display.split("/");
  const last = segments.pop() ?? "";
  const parent = segments.length > 0 ? segments.join("/") + "/" : "";

  const icons = getIcons();
  const icon = icons.folder ? icons.folder + " " : "";
  const iconW = icon.length;
  const full = parent + last;
  const fullW = full.length;
  const effectiveMax = maxLen - iconW;

  if (fullW <= effectiveMax) {
    const text = theme.fg("dim", icon) + (parent ? theme.fg("dim", parent) : "") + theme.bold(theme.fg("muted", last || "/"));
    return { text, width: iconW + fullW };
  }

  // Truncate: "…/last"
  const ellipsis = "…/";
  const available = effectiveMax - ellipsis.length;

  if (last.length <= available) {
    return {
      text: theme.fg("dim", icon + ellipsis) + theme.bold(theme.fg("muted", last)),
      width: iconW + ellipsis.length + last.length,
    };
  }

  // Last itself too long
  const truncLast = last.slice(0, Math.max(1, available - 1)) + "…";
  return {
    text: theme.fg("dim", icon + ellipsis) + theme.bold(theme.fg("muted", truncLast)),
    width: maxLen,
  };
}

// ── Git formatting ────────────────────────────────────────────────────────────

function formatGit(state: GitState, theme: any): { text: string; width: number } {
  let text = "";
  let width = 0;

  const add = (str: string, color: string) => {
    text += theme.fg(color, str);
    width += str.length;
  };

  const icons = getIcons();
  const gitIcon = state.isGitHub
    ? (hasNerdFonts() ? GITHUB_ICON : GITHUB_ICON_ASCII)
    : icons.git;
  const gitPrefix = gitIcon ? ` ${gitIcon} ${icons.branch} ` : ` ${icons.branch} `;
  add(gitPrefix + state.branch, "accent");

  if (state.behind > 0)   add(` ⇣${state.behind}`, "error");
  if (state.ahead > 0)    add(` ⇡${state.ahead}`, "success");
  if (state.staged > 0)   add(` ✚${state.staged}`, "success");
  if (state.modified > 0) add(` !${state.modified}`, "warning");
  if (state.untracked > 0) add(` …${state.untracked}`, "dim");

  return { text, width };
}

// ── Shared number formatter ───────────────────────────────────────────────────

function fmt(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ── Render a full-width selectedBg line ───────────────────────────────────────

function bgLine(theme: any, content: string, width: number): string {
  const innerW = width - 2;
  const c = truncateToWidth(content, innerW);
  const cW = visibleWidth(c);
  const padded = " " + c + (cW < innerW ? " ".repeat(innerW - cW) : "") + " ";
  return theme.bg("selectedBg", padded);
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
    const sessionStart = Date.now();

    // Git cache
    let gitState: GitState | null = null;
    let gitAvailable = true;

    async function fetchGit() {
      if (!gitAvailable) return;
      try {
        const [statusR, remoteR] = await Promise.all([
          pi.exec("git", ["status", "--porcelain=v2", "--branch"], { cwd: ctx.cwd, timeout: 3000 }),
          pi.exec("git", ["remote", "get-url", "origin"], { cwd: ctx.cwd, timeout: 3000 }),
        ]);
        if (statusR.code === 128) { gitAvailable = false; return; }
        if (statusR.code !== 0) { gitState = null; return; }
        const state = parseGitStatus(statusR.stdout);
        state.isGitHub = remoteR.code === 0 && remoteR.stdout.includes("github.com");
        gitState = state;
      } catch {
        gitState = null;
      }
    }

    fetchGit();

    // ── ABOVE EDITOR: stats widget ──────────────────────────────────────────

    ctx.ui.setWidget("stats-bar", (tui: any, theme: any) => {
      const timer = setInterval(() => tui.requestRender(), 1000);

      return {
        dispose() { clearInterval(timer); },
        invalidate() {},
        render(width: number): string[] {

          // Token stats
          let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCost = 0;
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const m = entry.message as any;
              totalInput    += m.usage.input;
              totalOutput   += m.usage.output;
              totalCacheRead += m.usage.cacheRead;
              totalCost     += m.usage.cost.total;
            }
          }

          // Context usage
          let contextPercent = 0, contextWindow = 0, contextStr = "?";
          const cu = ctx.getContextUsage();
          if (cu) {
            contextPercent = (cu as any).percent ?? 0;
            contextWindow  = (cu as any).contextWindow ?? 0;
            contextStr     = `${contextPercent.toFixed(0)}%`;
          }

          // Session timer
          const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
          const h = Math.floor(elapsed / 3600);
          const m = Math.floor((elapsed % 3600) / 60);
          const s = elapsed % 60;
          const timeStr = h > 0
            ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
            : `${m}:${String(s).padStart(2, "0")}`;

          // Model + thinking
          const icons = getIcons();
          const fullModelId = ctx.model?.id ?? "no-model";
          const modelId = fullModelId.replace(/^.*\//, "").replace(/-\d{8}$/, "").replace(/@.*$/, "");
          const thinkingLevel = pi.getThinkingLevel();
          const thinkingText = thinkingLevel && thinkingLevel !== "none" ? getThinkingText(thinkingLevel) : undefined;
          const modelDisplay = thinkingText
            ? modelId + " " + theme.fg("dim", thinkingText)
            : modelId;
          const modelDisplayW = thinkingText
            ? visibleWidth(modelId) + 1 + visibleWidth(thinkingText)
            : visibleWidth(modelId);

          // Progress bar
          const barTotal = 12;
          const barFilled = Math.round((contextPercent / 100) * barTotal);
          const barEmpty  = barTotal - barFilled;
          let barColor: string;
          if (contextPercent > 90) barColor = "error";
          else if (contextPercent > 70) barColor = "warning";
          else barColor = "success";
          const progressBar =
            theme.fg("dim", "[") +
            theme.fg(barColor, "█".repeat(barFilled)) +
            theme.fg("dim", "░".repeat(barEmpty)) +
            theme.fg("dim", "]");
          const contextLabel = contextPercent > 90
            ? theme.fg("error", contextStr)
            : contextPercent > 70 ? theme.fg("warning", contextStr) : theme.fg("muted", contextStr);
          const contextWindowLabel = contextWindow > 0 ? `/${fmt(contextWindow)}` : "";

          // Right side: tokens + cost + timer
          const SEP   = theme.fg("dim", " │ ");
          const SEP_W = 3;
          const tokenParts: string[] = [];
          const tokenPartsW: number[] = [];
          if (totalInput || totalOutput) {
            const t = `↑${fmt(totalInput)} ↓${fmt(totalOutput)}`;
            tokenParts.push(theme.fg("dim", t)); tokenPartsW.push(t.length);
          }
          if (totalCacheRead) {
            const t = `R${fmt(totalCacheRead)}`;
            tokenParts.push(theme.fg("dim", t)); tokenPartsW.push(t.length);
          }
          if (totalCost > 0) {
            const t = `$${totalCost.toFixed(3)}`;
            tokenParts.push(theme.fg("dim", t)); tokenPartsW.push(t.length);
          }
          const clockIcon = icons.time ? icons.time + " " : "";
          const timerPart = theme.fg("accent", clockIcon + timeStr);
          const timerW    = clockIcon.length + timeStr.length;
          const tokenJoinedW = tokenPartsW.reduce((a, b) => a + b, 0) + Math.max(0, tokenPartsW.length - 1);
          const rightStr = tokenJoinedW > 0
            ? tokenParts.join(" ") + SEP + timerPart
            : timerPart;
          const rightW = tokenJoinedW > 0 ? tokenJoinedW + SEP_W + timerW : timerW;

          // Left side
          const starPi    = theme.fg("accent", icons.pi);
          const modelStr  = theme.fg("muted", modelDisplay);
          const leftParts = starPi + "  " + modelStr;
          const leftW     = 1 + 2 + modelDisplayW;

          const ctxPart  = progressBar + " " + contextLabel + theme.fg("muted", contextWindowLabel);
          const ctxW     = 2 + barTotal + 1 + visibleWidth(contextStr) + visibleWidth(contextWindowLabel);
          const ctxCmpct = progressBar + " " + contextLabel;
          const ctxCmpctW = 2 + barTotal + 1 + visibleWidth(contextStr);

          const truncModel = (maxW: number) => {
            if (modelDisplayW <= maxW) return { str: modelStr, w: modelDisplayW };
            const t = modelId.slice(0, Math.max(3, maxW - 1)) + "…";
            return { str: theme.fg("muted", t), w: t.length };
          };

          const G = " ", GW = 1;
          const usableW = width - 2;
          const totalNeeded = leftW + GW + ctxW + SEP_W + rightW;

          let line: string;
          if (totalNeeded <= usableW) {
            const mid = leftParts + G + ctxPart;
            const gap = usableW - (leftW + GW + ctxW) - rightW;
            line = mid + " ".repeat(Math.max(1, gap)) + rightStr;
          } else if (leftW + GW + ctxW + SEP_W + timerW <= usableW) {
            const mid = leftParts + G + ctxPart;
            const gap = usableW - (leftW + GW + ctxW) - timerW;
            line = mid + " ".repeat(Math.max(1, gap)) + timerPart;
          } else if (leftW + GW + ctxW + 1 <= usableW) {
            const mid = leftParts + G + ctxPart;
            const gap = usableW - (leftW + GW + ctxW);
            line = mid + (gap > 0 ? " ".repeat(gap) : "");
          } else if (leftW + GW + ctxCmpctW + 1 <= usableW) {
            const sec = leftParts + G + ctxCmpct;
            const gap = usableW - (leftW + GW + ctxCmpctW);
            line = sec + (gap > 0 ? " ".repeat(gap) : "");
          } else {
            const avail = usableW - 1 - GW - ctxCmpctW;
            if (avail >= 4) {
              const tm = truncModel(avail);
              line = truncateToWidth(starPi + " " + tm.str + G + ctxCmpct, usableW);
            } else {
              line = truncateToWidth(starPi + " " + ctxCmpct, usableW);
            }
          }

          return [bgLine(theme, line, width)];
        },
      };
    }, { placement: "aboveEditor" });

    // ── FOOTER: cwd + git ───────────────────────────────────────────────────

    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      const gitTimer = setInterval(async () => {
        await fetchGit();
        tui.requestRender();
      }, 5000);
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose() { clearInterval(gitTimer); unsub(); },
        invalidate() {},
        render(width: number): string[] {
          const usableW = width - 2;
          const CWD_MAX = Math.floor(usableW * 0.55);

          const cwd = formatCwd(ctx.cwd, CWD_MAX, theme);

          if (!gitState) {
            return [bgLine(theme, cwd.text, width)];
          }

          const git = formatGit(gitState, theme);
          const line = cwd.text + "  " + git.text;
          return [bgLine(theme, line, width)];
        },
      };
    });
  });
}
