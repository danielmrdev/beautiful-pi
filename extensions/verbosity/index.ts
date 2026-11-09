import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "../shared/settings.ts";

interface Counts {
  tools: number;
  thoughts: number;
  edits: number;
  reads: number;
  commands: number;
}

const state: { active: boolean; counts: Counts } = {
  active: false,
  counts: { tools: 0, thoughts: 0, edits: 0, reads: 0, commands: 0 },
};

function isLow(): boolean {
  return loadSettings().verbosity === "low";
}

function resetCounts(): void {
  state.counts = { tools: 0, thoughts: 0, edits: 0, reads: 0, commands: 0 };
}

function summaryText(): string {
  const c = state.counts;
  const parts: string[] = [`${c.tools} tool${c.tools === 1 ? "" : "s"}`];
  const detail: string[] = [];
  if (c.edits) detail.push(`${c.edits} edit${c.edits === 1 ? "" : "s"}`);
  if (c.reads) detail.push(`${c.reads} read${c.reads === 1 ? "" : "s"}`);
  if (c.commands) detail.push(`${c.commands} cmd${c.commands === 1 ? "" : "s"}`);
  if (detail.length) parts.push(`(${detail.join(", ")})`);
  if (c.thoughts) parts.push(`· ${c.thoughts} thought${c.thoughts === 1 ? "" : "s"}`);
  return parts.join(" ");
}

function updateWorking(ctx: ExtensionContext): void {
  if (!ctx.hasUI || !isLow()) return;
  try {
    const msg = state.counts.tools === 0 && state.counts.thoughts === 0
      ? "Thinking…"
      : summaryText();
    ctx.ui.setWorkingMessage(msg);
  } catch {
    // best effort
  }
}

export default function verbosityExtension(pi: ExtensionAPI): void {
  // Register a renderer for the final summary line left in the chat.
  if (typeof (pi as any).registerMessageRenderer === "function") {
    (pi as any).registerMessageRenderer("bpi-verbosity-summary", (message: any, _options: any, theme: any) => {
    const text = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? (message.content as any[]).filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ")
        : String(message.content ?? "");
    const settings = loadSettings();
    const indent = " ".repeat(settings.indentLevel);
    const rail = (theme as any)?.fg ? (theme as any).fg(settings.toolRailColor, "┃") : "┃";
    const prefix = `${indent}${rail} `;
    return {
      render(width: number) {
        const inner = Math.max(1, width - (indent.length + 2));
        const line = (theme as any)?.fg
          ? (theme as any).fg("muted", text)
          : text;
        return [`${prefix}${line}`.slice(0, width)];
      },
      invalidate() {},
    } as any;
    });
  }

  pi.on("session_start", (_event: any, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const v = loadSettings().verbosity;
    try {
      const { SettingsManager } = require("@earendil-works/pi-coding-agent");
      const sm = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
      if (v === "high") sm.setHideThinkingBlock(false);
      else if (v === "low") sm.setHideThinkingBlock(true);
    } catch {
      // ignore
    }
  });

  pi.on("agent_start", (_event: any, ctx: ExtensionContext) => {
    if (!isLow()) return;
    resetCounts();
    state.active = true;
    updateWorking(ctx);
  });

  pi.on("message_update", (event: any, ctx: ExtensionContext) => {
    if (!isLow() || !state.active) return;
    const evt = event?.assistantMessageEvent;
    if (evt?.type === "thinking_start") {
      state.counts.thoughts += 1;
      try { ctx.ui.setWorkingMessage("Thinking…"); } catch {}
    } else if (evt?.type === "text_start") {
      updateWorking(ctx);
    }
  });

  pi.on("tool_execution_start", (event: any, ctx: ExtensionContext) => {
    if (!isLow() || !state.active) return;
    state.counts.tools += 1;
    const name = String(event?.toolName ?? "");
    if (name === "edit") state.counts.edits += 1;
    else if (name === "read") state.counts.reads += 1;
    else if (name === "bash") state.counts.commands += 1;
    updateWorking(ctx);
  });

  pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
    if (!isLow() || !state.active) return;
    state.active = false;
    const text = summaryText();
    try { ctx.ui.setWorkingMessage(undefined); } catch {}
    try {
      await (pi as any).sendMessage(
        { customType: "bpi-verbosity-summary", content: text, display: true },
        { triggerTurn: false },
      );
    } catch {
      // ignore
    }
  });
}