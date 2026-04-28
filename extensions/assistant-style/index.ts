/**
 * Patches AssistantMessageComponent to render:
 *  - Text blocks:     accent-coloured ┃ left rail
 *  - Thinking blocks: thinkingText-coloured ┃ left rail, italic content
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { AssistantMessageComponent } from "@mariozechner/pi-coding-agent";
import { Markdown, Spacer, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { loadSettings, safeFg } from "../shared/settings.ts";

// ── Theme store ───────────────────────────────────────────────────────────────

let _theme: any = null;

function setTheme(theme: any): void { _theme = theme; }

// ── Rail helpers ──────────────────────────────────────────────────────────────

const RAIL = "┃";
const RAIL_PREFIX = "┃ "; // 2 visible chars

function trimEdgeBlankLines(lines: string[]): string[] {
  let start = 0, end = lines.length;
  while (start < end && lines[start]?.trim().length === 0) start++;
  while (end > start && lines[end - 1]?.trim().length === 0) end--;
  return lines.slice(start, end);
}

function renderRailLine(line: string, width: number, railColorToken: string, fallbackColor: string, indent = ""): string {
  const theme = _theme;
  const safeWidth = Math.max(1, Math.floor(width));
  const rail = safeFg(theme, railColorToken, fallbackColor, RAIL);
  const prefix = `${indent}${rail} `;
  const contentWidth = Math.max(1, safeWidth - indent.length - visibleWidth(RAIL_PREFIX));
  return `${prefix}${truncateToWidth(line, contentWidth, "", true)}`;
}

// ── Agent text block ──────────────────────────────────────────────────────────

function createAgentMarkdownBlock(text: string, markdownTheme: unknown) {
  const md = new Markdown(text.trim(), 0, 0, markdownTheme as never, undefined as never);
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, Math.floor(width));
      const contentWidth = Math.max(1, safeWidth - visibleWidth(RAIL_PREFIX));
      const lines = trimEdgeBlankLines(md.render(contentWidth));
      const body = lines.length > 0 ? lines : [""];
      return body.map(line => renderRailLine(line, safeWidth, "accent", "accent"));
    },
    invalidate() { md.invalidate?.(); },
  };
}

function createAgentTextLine(text: string) {
  return {
    render(width: number): string[] {
      return [renderRailLine(text, Math.max(1, Math.floor(width)), "accent", "accent")];
    },
    invalidate() {},
  };
}

// ── Thinking block ────────────────────────────────────────────────────────────

function getThinkingIndent(): string {
  return " ".repeat(loadSettings().indentLevel);
}

function createThinkingBlock(text: string, markdownTheme: unknown) {
  const theme = _theme;
  const settings = loadSettings();
  const defaultStyle = theme
    ? { color: (t: string) => safeFg(theme, settings.thinkingTextColor, "muted", t), italic: true }
    : undefined;
  const md = new Markdown(text.trim(), 0, 0, markdownTheme as never, defaultStyle as never);
  const indent = getThinkingIndent();
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, Math.floor(width));
      const contentWidth = Math.max(1, safeWidth - indent.length - visibleWidth(RAIL_PREFIX));
      const lines = trimEdgeBlankLines(md.render(contentWidth));
      const body = lines.length > 0 ? lines : [""];
      return body.map(line => renderRailLine(line, safeWidth, settings.thinkingRailColor, "accent", indent));
    },
    invalidate() { md.invalidate?.(); },
  };
}

// ── Patch ─────────────────────────────────────────────────────────────────────

type PatchedProto = {
  updateContent(message: any): void;
  contentContainer?: any;
  markdownTheme?: unknown;
  hideThinkingBlock?: boolean;
  hiddenThinkingLabel?: string;
  lastMessage?: any;
  hasToolCalls?: boolean;
  __assistantStyleOriginal?: (message: any) => void;
};

function patchAssistantMessage(): void {
  const proto = (AssistantMessageComponent as any).prototype as PatchedProto;
  if (typeof proto.updateContent !== "function") return;

  // Always re-apply so /reload picks up colour/layout changes immediately.
  // Save the original only once so repeated patches always restore from it.
  if (!proto.__assistantStyleOriginal) {
    proto.__assistantStyleOriginal = proto.updateContent;
  }

  proto.updateContent = function(this: PatchedProto, message: any): void {
    this.lastMessage = message;

    const contentContainer = this.contentContainer;
    if (!contentContainer) {
      this.__assistantStyleOriginal?.call(this, message);
      return;
    }

    contentContainer.clear();

    const theme = _theme;
    const settings = loadSettings();
    const hasVisibleThinking = message.content.some(
      (c: any) => c.type === "thinking" && c.thinking.trim()
    );

    let didStartAgentBlock = false;
    if (hasVisibleThinking) contentContainer.addChild(new Spacer(1));

    for (let i = 0; i < message.content.length; i++) {
      const content = message.content[i];

      if (content.type === "text" && content.text.trim()) {
        if (!didStartAgentBlock) {
          if (!hasVisibleThinking) contentContainer.addChild(new Spacer(1));
          didStartAgentBlock = true;
        }
        contentContainer.addChild(createAgentMarkdownBlock(content.text, this.markdownTheme));

      } else if (content.type === "thinking" && content.thinking.trim()) {
        const hasVisibleContentAfter = message.content
          .slice(i + 1)
          .some((c: any) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

        if (this.hideThinkingBlock) {
          const label = this.hiddenThinkingLabel ?? "Thinking...";
          const styled = theme ? theme.italic(safeFg(theme, settings.thinkingTextColor, "muted", label)) : label;
          contentContainer.addChild({
            render: (width: number) => [renderRailLine(styled, width, settings.thinkingRailColor, "accent", getThinkingIndent())],
            invalidate: () => {},
          });
        } else {
          contentContainer.addChild(createThinkingBlock(content.thinking, this.markdownTheme));
        }
        if (hasVisibleContentAfter) contentContainer.addChild(new Spacer(1));
      }
    }

    const hasToolCalls = message.content.some((c: any) => c.type === "toolCall");
    this.hasToolCalls = hasToolCalls;

    if (!hasToolCalls) {
      if (message.stopReason === "aborted") {
        const msg = message.errorMessage && message.errorMessage !== "Request was aborted"
          ? message.errorMessage : "Operation aborted";
        contentContainer.addChild(new Spacer(1));
        contentContainer.addChild(createAgentTextLine(safeFg(theme, "error", "error", msg)));
      } else if (message.stopReason === "error") {
        const msg = message.errorMessage || "Unknown error";
        contentContainer.addChild(new Spacer(1));
        contentContainer.addChild(createAgentTextLine(safeFg(theme, "error", "error", `Error: ${msg}`)));
      }
    }
  } as PatchedProto["updateContent"];

}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function assistantStyleExtension(pi: ExtensionAPI): void {
  const applyPatch = (_event: any, ctx: ExtensionContext) => {
    setTheme(ctx.hasUI ? (ctx.ui as any).theme : null);
    patchAssistantMessage();
  };

  pi.on("session_start", applyPatch);
  pi.on("before_agent_start", applyPatch);
}
