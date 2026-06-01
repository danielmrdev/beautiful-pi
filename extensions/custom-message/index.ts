/**
 * Patches CustomMessageComponent to render with the beautiful-pi rail style.
 *
 * All custom messages (web-search-results, curator-config, RTK entries, etc.)
 * get:
 *   <indent> ┃ <customType label>
 *   <indent> ┃ <content line 1>
 *   <indent> ┃ <content line 2>
 *   ...
 *
 * Rail colour is driven by settings.customMessageRailColor (default: borderMuted).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomMessageComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadSettings, safeFg } from "../shared/settings.ts";

// ── Theme store ───────────────────────────────────────────────────────────────

let _theme: any = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const RAIL = "┃";

function prettyType(customType: string): string {
  return customType.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => String(c.text ?? ""))
      .join("\n");
  }
  return "";
}

// ── Rail component ────────────────────────────────────────────────────────────

class CustomMessageRail {
  private message: any;

  constructor(message: any) {
    this.message = message;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const theme = _theme;
    const settings = loadSettings();
    const indent = " ".repeat(settings.indentLevel);
    const rail = safeFg(theme, settings.customMessageRailColor, "borderMuted", RAIL);
    const prefix = `${indent}${rail} `;
    const prefixWidth = settings.indentLevel + 2; // indent + "┃ "
    const contentWidth = Math.max(1, width - prefixWidth);

    const lines: string[] = [];

    // ── Label line (customType) ───────────────────────────────────────────────
    const label = prettyType(this.message.customType);
    const styledLabel = safeFg(theme, "customMessageLabel", "muted", label);
    lines.push(`${prefix}${truncateToWidth(styledLabel, contentWidth)}`);

    // ── Content lines ─────────────────────────────────────────────────────────
    const text = extractText(this.message.content).trim();
    if (text) {
      const rawLines = text.split("\n");
      for (const raw of rawLines) {
        const trimmed = raw.trimEnd();
        if (trimmed === "") {
          lines.push(`${prefix}`);
        } else {
          // Word-wrap long lines
          const chunks = chunkLine(trimmed, contentWidth);
          for (const chunk of chunks) {
            const styled = settings.dimCustomMessages
            ? safeFg(theme, "customMessageText", "muted", chunk)
            : chunk;
            lines.push(`${prefix}${styled}`);
          }
        }
      }
    }

    return lines;
  }
}

/** Split a plain text line into chunks of at most maxW visible chars. */
function chunkLine(line: string, maxW: number): string[] {
  if (maxW <= 0) return [line];
  const chunks: string[] = [];
  let remaining = line;
  while (visibleWidth(remaining) > maxW) {
    chunks.push(truncateToWidth(remaining, maxW));
    remaining = remaining.slice(maxW); // rough slice (no ANSI in raw text)
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ── Patch ─────────────────────────────────────────────────────────────────────

export function patchCustomMessageComponent(): void {
  const proto = (CustomMessageComponent as any).prototype;

  // Save original once so /reload always restores from the true baseline.
  if (!proto.__beautifulPiOrigRebuild) {
    proto.__beautifulPiOrigRebuild = proto.rebuild;
  }

  proto.rebuild = function(this: any) {
    // Remove any previously injected custom component.
    if (this.customComponent) {
      this.removeChild(this.customComponent);
      this.customComponent = undefined;
    }
    this.removeChild(this.box);

    const rail = new CustomMessageRail(this.message);
    this.customComponent = rail;
    this.addChild(rail);
  };
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function customMessageExtension(pi: ExtensionAPI): void {
  const applyPatch = (_event: any, ctx: ExtensionContext) => {
    _theme = ctx.hasUI ? (ctx.ui as any).theme : null;
    patchCustomMessageComponent();
  };

  pi.on("session_start", applyPatch);
  pi.on("before_agent_start", applyPatch);
}
