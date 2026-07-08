/**
 * Patches UserMessageComponent to render a coloured ┃ left rail,
 * consistent with the agent rail in assistant-style.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadSettings, safeFg } from "../shared/settings.ts";

// ── Theme store ───────────────────────────────────────────────────────────────

let _theme: any = null;

// ── Constants ─────────────────────────────────────────────────────────────────

const RAIL      = "┃";
const RAIL_SEP  = "";
const RAIL_W    = visibleWidth(RAIL + RAIL_SEP); // 1

// OSC 133 semantic zone markers added by UserMessageComponent
const OSC_START = "\x1b]133;A\x07";
const OSC_END   = "\x1b]133;B\x07";
const OSC_FINAL = "\x1b]133;C\x07";
const OSC_EF    = OSC_END + OSC_FINAL;

// ── Patch ─────────────────────────────────────────────────────────────────────

type PatchedProto = {
  render(width: number): string[];
  __userStyleOriginalRender?: (width: number) => string[];
};

function patchUserMessage(): void {
  const proto = (UserMessageComponent as any).prototype as PatchedProto;
  if (typeof proto.render !== "function") return;

  // Save original only once so repeated patches always restore from it.
  if (!proto.__userStyleOriginalRender) {
    proto.__userStyleOriginalRender = proto.render;
  }

  proto.render = function (this: PatchedProto, width: number): string[] {
    const theme = _theme;
    const settings = loadSettings();
    const rail = safeFg(theme, settings.userRailColor, "accent", RAIL);
    const prefix = rail + RAIL_SEP;

    // Render with reduced width to make room for the rail prefix
    const lines = proto.__userStyleOriginalRender!.call(this, Math.max(1, width - RAIL_W));

    if (lines.length === 0) return lines;

    return lines.map((line: string, i: number) => {
      // Preserve OSC markers at the very front of the line
      let osc  = "";
      let rest = line;

      if (i === 0 && rest.startsWith(OSC_START)) {
        osc  = OSC_START;
        rest = rest.slice(OSC_START.length);
      }
      if (i === lines.length - 1 && rest.startsWith(OSC_EF)) {
        osc  += OSC_EF;
        rest  = rest.slice(OSC_EF.length);
      }

      return osc + prefix + rest;
    });
  };
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function userStyleExtension(pi: ExtensionAPI): void {
  const apply = (_event: any, ctx: ExtensionContext) => {
    _theme = ctx.hasUI ? (ctx.ui as any).theme : null;
    patchUserMessage();
  };

  pi.on("session_start",      apply);
  pi.on("before_agent_start", apply);
}
