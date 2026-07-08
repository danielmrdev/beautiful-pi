/**
 * Shared helpers for tools-one-line:
 * spinner, path utils, OneLine component, renderLine, registerTool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { loadSettings, safeFg } from "../shared/settings.ts";

const { resolve } = require("node:path");
const { homedir } = require("node:os");

// ── Intent property ─────────────────────────────────────────────────────────────

export const intentProperty = {
  type: "string",
  description: "Short note explaining why this tool call helps accomplish the current task. Always populate this field.",
} as const;

// ── Spinner ───────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_MS = 80;

export const currentFrame = () =>
  FRAMES[Math.floor(Date.now() / FRAME_MS) % FRAMES.length] ?? "⠋";

// True only while the agent is actively running (between agent_start and agent_end).
// Zombie tools (from a resumed session) have isPartial=true but agent is NOT active.
// We use this to skip the spinner and show done state for zombie tools.
export let isAgentActive = false;
export function setAgentActive(v: boolean): void { isAgentActive = v; }

// ── Path helpers ──────────────────────────────────────────────────────────────

const HOME = homedir() as string;

export function prettyPath(p: string): string {
  return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
}

export function absPath(p: string | undefined, cwd: string): string {
  return prettyPath(resolve(cwd, (p ?? "").replace(/^@/, "").trim() || "."));
}

export function readRange(offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return "";
  const s = offset ?? 1;
  return limit === undefined ? `:${s}` : `:${s}–${s + limit - 1}`;
}

export function compact(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

// ── Built-in tool definitions (cached per cwd) ────────────────────────────────

export type ToolName = "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls";

const _defCache = new Map<string, Record<ToolName, any>>();

export function getDefs(cwd: string): Record<ToolName, any> {
  if (!_defCache.has(cwd)) {
    _defCache.set(cwd, {
      bash:  createBashToolDefinition(cwd),
      read:  createReadToolDefinition(cwd),
      write: createWriteToolDefinition(cwd),
      edit:  createEditToolDefinition(cwd),
      grep:  createGrepToolDefinition(cwd),
      find:  createFindToolDefinition(cwd),
      ls:    createLsToolDefinition(cwd),
    });
  }
  return _defCache.get(cwd)!;
}

// ── ANSI-safe truncation ──────────────────────────────────────────────────────

export function truncate(str: string, maxW: number): string {
  return truncateToWidth(str, maxW);
}

// ── One-line component ────────────────────────────────────────────────────────

/**
 * A zero-height component returned by renderResult (non-expanded) so that
 * pi doesn't stack a duplicate of the renderCall line below itself.
 */
export class NullWidget {
  render(_width: number): string[] { return []; }
  invalidate(): void {}
  dispose(): void {}
}

export class OneLine {
  private _text = "";
  private _intent = "";
  private _timer?: ReturnType<typeof setInterval>;
  done = false;

  set(text: string, intent?: string, done = false): void {
    // Once done, never go back to active state
    if (this.done && !done) return;
    this._text = text;
    this._intent = intent ?? "";
    this.done = done;
  }

  startTimer(invalidate: () => void): void {
    if (!this._timer) this._timer = setInterval(invalidate, FRAME_MS);
  }

  stopTimer(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const lines: string[] = [];
    if (this._intent) lines.push(truncate(this._intent, w));
    lines.push(truncate(this._text, w));
    return lines;
  }

  invalidate(): void {}
}

// ── Render context / theme types ──────────────────────────────────────────────

export type Ctx = {
  isPartial: boolean;
  isError: boolean;
  expanded: boolean;
  argsComplete: boolean;
  executionStarted: boolean;
  state: Record<string, unknown>; // kept for API compat, timer now lives on OneLine
  invalidate(): void;
  args: any;
  cwd: string;
  lastComponent?: unknown;
};

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

// ── Indent helper (reads settings per call so /reload picks up changes) ───────

function getToolIndent(): string {
  return " ".repeat(loadSettings().indentLevel);
}

// ── Status line renderer ──────────────────────────────────────────────────────

export function renderLine(ctx: Ctx, theme: Theme, label: string, intent?: string): OneLine {
  const settings = loadSettings();
  const indent = getToolIndent();
  const comp = ctx.lastComponent instanceof OneLine
    ? ctx.lastComponent
    : new OneLine();

  if (!comp.done && (ctx.isPartial || !ctx.argsComplete) && isAgentActive) {
    const rail = safeFg(theme, settings.toolRailColor, "muted", "┃");
    const prefix = `${indent}${rail} `;
    comp.startTimer(ctx.invalidate);
    const intentLine = intent ? `${prefix}${safeFg(theme, settings.thinkingTextColor, "muted", intent)}` : undefined;
    const connector = intentLine ? theme.fg("dim", "  └─ ") : ``;
    comp.set(`${prefix}${connector}${theme.fg("dim", currentFrame())} ${theme.fg("muted", label)}`, intentLine);
  } else {
    comp.stopTimer();
    const railColor = ctx.isError ? "error" : "success";
    const rail = theme.fg(railColor, "┃");
    const prefix = `${indent}${rail} `;
    const icon = ctx.isError
      ? theme.fg("error", "✕")
      : theme.fg("success", "✓");
    const intentLine = intent ? `${prefix}${theme.fg("dim", intent)}` : undefined;
    const connector = intentLine ? theme.fg("dim", "  └─ ") : ``;
    comp.set(`${prefix}${connector}${icon} ${label}`, intentLine, true);
  }

  return comp;
}

// ── Tool registration helper ──────────────────────────────────────────────────

export type LabelFn = (args: any, cwd: string, theme: Theme) => string;

function getRegistered(pi: ExtensionAPI): Set<string> {
  const p = pi as any;
  if (!p.__beautifulPiToolsRegistered) p.__beautifulPiToolsRegistered = new Set<string>();
  return p.__beautifulPiToolsRegistered;
}

function makeDimTheme(theme: Theme): Theme {
  return {
    fg: (_color: string, text: string) => theme.fg("dim", text),
    bold: (text: string) => text,
  };
}

function getIntent(args: any): string | undefined {
  const v = args?.intent;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function registerTool(pi: ExtensionAPI, name: ToolName, buildLabel: LabelFn): void {
  const _registered = getRegistered(pi);
  if (_registered.has(name)) return;
  _registered.add(name);

  const base = getDefs(process.cwd())[name];

  // Inject the intent field into tool parameters
  const parameters = {
    ...base.parameters,
    properties: {
      intent: intentProperty,
      ...(base.parameters.properties ?? {}),
    },
    required: [...new Set(["intent", ...(base.parameters.required ?? [])])],
  };

  pi.registerTool({
    name:        base.name,
    label:       base.label,
    description: base.description,
    parameters,
    renderShell: "self" as const,

    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      // Strip intent before passing to the built-in executor
      const { intent: _intent, ...cleanParams } = params ?? {};
      return getDefs(ctx.cwd)[name].execute(toolCallId, cleanParams, signal, onUpdate, ctx);
    },

    renderCall(args: any, theme: any, context: any) {
      const ctx = context as Ctx;
      const intent = getIntent(args);
      // A tool is visually "done" if it truly completed OR if the agent is not
      // active (zombie tool from a resumed session — isPartial stays true forever).
      const isDone = (!ctx.isPartial && ctx.argsComplete) || !isAgentActive;
      const dimThemeSettings = loadSettings();
      const labelTheme = isDone && dimThemeSettings.dimToolsText ? makeDimTheme(theme as Theme) : (theme as Theme);
      return renderLine(ctx, theme as Theme, buildLabel(args, ctx.cwd, labelTheme), intent);
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      const ctx = context as Ctx;

      if (!options.expanded) {
        // renderCall already shows the ✓/✕ done state.
        // Returning a zero-height NullWidget prevents a duplicate line from
        // being stacked below the call renderer by pi's updateDisplay().
        return ctx.lastComponent instanceof NullWidget
          ? ctx.lastComponent
          : new NullWidget();
      }

      // Expanded: delegate to built-in renderer — stop our timer first
      if (ctx.lastComponent instanceof OneLine) ctx.lastComponent.stopTimer();
      const builtIn = getDefs(ctx.cwd)[name];
      const dimSettings = loadSettings();
      const dimTheme = dimSettings.dimToolsText ? makeDimTheme(theme as Theme) : (theme as Theme);
      const label = buildLabel(ctx.args, ctx.cwd, dimTheme);
      const intent = getIntent(ctx.args);
      return builtIn.renderResult?.(result, options, theme, context)
        ?? renderLine({ ...ctx, isPartial: false, argsComplete: true }, theme as Theme, label, intent);
    },
  } as any);
}
