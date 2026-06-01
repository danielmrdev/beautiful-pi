/**
 * Generic rail renderer for any tool not explicitly handled by beautiful-pi.
 *
 * Patches ToolExecutionComponent.prototype so that tools without a custom
 * renderCall (fetch_content, web_search, MCP tools, etc.) render with the
 * same ┃ rail + spinner / ✓ / ✕ style as the explicitly registered tools.
 */

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { NullWidget, renderLine, type Ctx, type Theme } from "./shared.ts";

// Tools that beautiful-pi registers explicitly — leave their renderers alone.
const HANDLED_TOOLS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);

function prettyName(toolName: string): string {
  return toolName.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function getIntent(args: any): string | undefined {
  const v = args?.intent;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

type AnyFn = (...a: any[]) => any;

interface GenericOriginals {
  getCallRenderer: AnyFn;
  getResultRenderer: AnyFn;
  getRenderShell: AnyFn;
  updateDisplay: AnyFn;
}

export function patchGenericToolRenderer(): void {
  const proto = (ToolExecutionComponent as any).prototype;

  // Save the true originals once so repeated /reload patches always restore
  // from the unmodified baseline (same pattern as assistant-style).
  if (!proto.__genericOriginals) {
    proto.__genericOriginals = {
      getCallRenderer:  proto.getCallRenderer,
      getResultRenderer: proto.getResultRenderer,
      getRenderShell:   proto.getRenderShell,
      updateDisplay:    proto.updateDisplay,
    } as GenericOriginals;
  }

  const orig = proto.__genericOriginals as GenericOriginals;

  // ── getRenderShell ────────────────────────────────────────────────────────
  // Return "self" for unhandled tools so the component uses selfRenderContainer
  // (plain Container, no coloured box wrapping our rail).

  proto.getRenderShell = function(this: any): string {
    if (HANDLED_TOOLS.has(this.toolName)) return orig.getRenderShell.call(this);
    return "self";
  };

  // ── getCallRenderer ───────────────────────────────────────────────────────

  proto.getCallRenderer = function(this: any): AnyFn {
    if (HANDLED_TOOLS.has(this.toolName)) return orig.getCallRenderer.call(this);
    const toolName = this.toolName;
    return (args: any, theme: Theme, ctx: Ctx) =>
      renderLine(ctx, theme, prettyName(toolName), getIntent(args));
  };

  // ── getResultRenderer ─────────────────────────────────────────────────────

  proto.getResultRenderer = function(this: any): AnyFn {
    if (HANDLED_TOOLS.has(this.toolName)) return orig.getResultRenderer.call(this);
    return (_result: any, opts: any, _theme: Theme, ctx: Ctx) => {
      if (!opts.expanded) {
        // renderCall already shows the done state; avoid a duplicate line.
        return ctx.lastComponent instanceof NullWidget
          ? ctx.lastComponent
          : new NullWidget();
      }
      // Expanded: fall through to original result renderer (full output)
      return orig.getResultRenderer.call(this)?.(
        _result, opts, _theme, ctx
      ) ?? new NullWidget();
    };
  };

  // ── updateDisplay ─────────────────────────────────────────────────────────
  // On /reload, ToolExecutionComponent instances already exist in the chat.
  // Their constructor ran before our patch and may have added `contentBox`
  // instead of `selfRenderContainer` as the active child.  Swap it here so
  // updateDisplay uses the right container.

  proto.updateDisplay = function(this: any) {
    if (!HANDLED_TOOLS.has(this.toolName) && this.selfRenderContainer) {
      const children: any[] = this.children;
      if (!children.includes(this.selfRenderContainer)) {
        const boxIdx  = children.indexOf(this.contentBox);
        const textIdx = children.indexOf(this.contentText);
        const target  = boxIdx !== -1 ? boxIdx : textIdx !== -1 ? textIdx : -1;
        if (target !== -1) {
          children[target] = this.selfRenderContainer;
        } else {
          this.addChild(this.selfRenderContainer);
        }
      }
    }
    orig.updateDisplay.call(this);
  };
}
