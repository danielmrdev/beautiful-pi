/**
 * Patches AssistantMessageComponent to render:
 *  - Text blocks:     agentRailColor-coloured ┃ left rail
 *  - Thinking blocks: thinkingText-coloured ┃ left rail, italic content
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { AssistantMessageComponent, CustomMessageComponent, SkillInvocationMessageComponent } from "@mariozechner/pi-coding-agent";
import { Markdown, Spacer, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { loadSettings, safeFg } from "../shared/settings.ts";
import { hasNerdFonts } from "../shared/icons.ts";

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
      const s = loadSettings();
      return body.map(line => renderRailLine(line, safeWidth, s.agentRailColor, "accent"));
    },
    invalidate() { md.invalidate?.(); },
  };
}

function createAgentTextLine(text: string) {
  return {
    render(width: number): string[] {
      const s = loadSettings();
      return [renderRailLine(text, Math.max(1, Math.floor(width)), s.agentRailColor, "accent")];
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
    ? { color: settings.dimThinkingText ? (t: string) => safeFg(theme, settings.thinkingTextColor, "muted", t) : undefined, italic: true }
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

// ── Skill block ─────────────────────────────────────────────────────────────────

const SKILL_ICON_NF  = "\uF5DA"; // nf-mdi-book  (Nerd Fonts)
const SKILL_ICON_ASCII = "[skill]";

function skillLabel(): string {
  return hasNerdFonts() ? SKILL_ICON_NF : SKILL_ICON_ASCII;
}

function createSkillMarkdownBlock(text: string, markdownTheme: unknown, indent = "") {
  const theme = _theme;
  const settings = loadSettings();
  const defaultStyle = (theme && settings.dimCustomMessages)
    ? { color: (t: string) => safeFg(theme, "muted", "muted", t) }
    : undefined;
  const md = new Markdown(text.trim(), 0, 0, markdownTheme as never, defaultStyle as never);
  return {
    render(width: number): string[] {
      const s = loadSettings();
      const safeWidth = Math.max(1, Math.floor(width));
      const contentWidth = Math.max(1, safeWidth - indent.length - visibleWidth(RAIL_PREFIX));
      const lines = trimEdgeBlankLines(md.render(contentWidth));
      const body = lines.length > 0 ? lines : [""];
      return body.map(line => renderRailLine(line, safeWidth, s.customMessageRailColor, "borderMuted", indent));
    },
    invalidate() { md.invalidate?.(); },
  };
}

// ── Patch SkillInvocationMessageComponent ────────────────────────────────────

type PatchedSkillProto = {
  updateDisplay(): void;
  skillBlock?: { name: string; location: string; content: string; userMessage?: string };
  markdownTheme?: unknown;
  expanded?: boolean;
  __beautifulSkillOriginal?: () => void;
};

function patchSkillInvocationMessage(): void {
  const proto = (SkillInvocationMessageComponent as any).prototype as PatchedSkillProto;
  if (typeof proto.updateDisplay !== "function") return;

  if (!proto.__beautifulSkillOriginal) {
    proto.__beautifulSkillOriginal = proto.updateDisplay;
  }

  proto.updateDisplay = function(this: PatchedSkillProto): void {
    (this as any).clear();
    const theme = _theme;
    const settings = loadSettings();
    const skillBlock = this.skillBlock;
    if (!skillBlock) {
      this.__beautifulSkillOriginal?.call(this);
      return;
    }

    const icon = skillLabel();
    const namePart = theme
      ? safeFg(theme, settings.dimCustomMessages ? "muted" : "text", "text", skillBlock.name)
      : skillBlock.name;
    const iconPart = theme
      ? safeFg(theme, settings.customMessageRailColor, "borderMuted", icon)
      : icon;

    const indent = getThinkingIndent();

    if (this.expanded) {
      // Header line: indent + ┃ 󰗊 name
      const headerText = `${iconPart} ${namePart}`;
      (this as any).addChild({
        render: (width: number) => [
          renderRailLine(headerText, Math.max(1, Math.floor(width)), settings.customMessageRailColor, "borderMuted", indent)
        ],
        invalidate: () => {},
      });
      // Content with rail + indent
      (this as any).addChild(new Spacer(1));
      (this as any).addChild(createSkillMarkdownBlock(skillBlock.content, this.markdownTheme, indent));
    } else {
      // Collapsed: indent + ┃ 󰗊 name
      const lineText = `${iconPart} ${namePart}`;
      (this as any).addChild({
        render: (width: number) => [
          renderRailLine(lineText, Math.max(1, Math.floor(width)), settings.customMessageRailColor, "borderMuted", indent)
        ],
        invalidate: () => {},
      });
    }
  } as PatchedSkillProto["updateDisplay"];
}

// ── Patch CustomMessageComponent ────────────────────────────────────────────

type PatchedCustomProto = {
  rebuild(): void;
  message?: { customType: string; content: unknown };
  markdownTheme?: unknown;
  customRenderer?: unknown;
  _expanded?: boolean;
  __beautifulCustomOriginal?: () => void;
};

function patchCustomMessage(): void {
  const proto = (CustomMessageComponent as any).prototype as PatchedCustomProto;
  if (typeof proto.rebuild !== "function") return;

  if (!proto.__beautifulCustomOriginal) {
    proto.__beautifulCustomOriginal = proto.rebuild;
  }

  proto.rebuild = function(this: PatchedCustomProto): void {
    // Let original do all cleanup + rendering first.
    this.__beautifulCustomOriginal?.call(this);

    // If a custom renderer produced a component, respect it entirely.
    if (this.customComponent) return;

    // We're in the default path: original re-added `box` with bg + label + markdown.
    // Replace it with our rail + indent styling.
    const message = this.message;
    if (!message) return;

    // Remove the box that was just added by the original.
    (this as any).removeChild((this as any).box);

    const settings = loadSettings();
    const indent = getThinkingIndent();

    // Extract text
    let text: string;
    if (typeof message.content === "string") {
      text = message.content as string;
    } else if (Array.isArray(message.content)) {
      text = (message.content as Array<any>)
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    } else {
      text = String(message.content ?? "");
    }

    // Label: indent + ┃ [customType]
    const labelText = safeFg(_theme, settings.dimCustomMessages ? "muted" : "text", "text", `[${message.customType}]`);
    const contentChild = text.trim()
      ? createSkillMarkdownBlock(text, this.markdownTheme, indent)
      : null;

    const wrapper = {
      render(width: number): string[] {
        const safeWidth = Math.max(1, Math.floor(width));
        const s = loadSettings();
        const lines = [renderRailLine(labelText, safeWidth, s.customMessageRailColor, "borderMuted", indent)];
        if (contentChild) lines.push(...contentChild.render(safeWidth));
        return lines;
      },
      invalidate() { contentChild?.invalidate(); },
    };

    // Store as customComponent so next rebuild removes it via the original's cleanup.
    (this as any).customComponent = wrapper;
    (this as any).addChild(wrapper);
  } as PatchedCustomProto["rebuild"];
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
    patchSkillInvocationMessage();
    patchCustomMessage();
  };

  pi.on("session_start", applyPatch);
  pi.on("before_agent_start", applyPatch);
}
