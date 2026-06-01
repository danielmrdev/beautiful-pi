/**
 * Session Title — auto-names the session from the first user message.
 *
 * On the first `input` event of a NEW session (no name yet):
 *   1. Fires a lightweight LLM call (same model, maxTokens=24) asking for
 *      "emoji title" in one line.
 *   2. Sets ctx.setSessionName() → visible in the session selector.
 *   3. Sets ctx.ui.setTitle()    → terminal tab title.
 *
 * Falls back to simple truncation if the LLM call fails.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import { loadSettings } from "../shared/settings.ts";

// ── Fallback: simple truncation ───────────────────────────────────────────────

const MAX_TITLE_CHARS = 48;

function truncateTitle(text: string): string {
  const firstLine = text
    .split("\n")
    .map(l => l.trim())
    .find(l => l.length > 0) ?? text.trim();

  const stripped = firstLine
    .replace(/^(please |can you |could you |hey[,!]?\s*|hi[,!]?\s*)/i, "")
    .trim();

  if (stripped.length <= MAX_TITLE_CHARS) return stripped;
  const cut = stripped.slice(0, MAX_TITLE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > MAX_TITLE_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

// ── LLM title synthesis ───────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a session title generator. " +
  "Given a user's first message to a coding assistant, reply with a single line: " +
  "one relevant emoji followed by a space and a concise 4-6 word title. " +
  'No quotes, no trailing punctuation, nothing else. Example: ✨ Add dark mode toggle';

async function synthesizeTitle(text: string, ctx: ExtensionContext): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error("no model");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);

  const response = await completeSimple(model, {
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: text.slice(0, 500),
        timestamp: Date.now(),
      },
    ],
  }, {
    maxTokens: 24,
    ...(auth.ok ? { apiKey: auth.apiKey, headers: auth.headers } : {}),
  });

  const raw = response.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("")
    .trim()
    .replace(/^["'`]|["'`]$/g, "") // strip wrapping quotes
    .trim();

  return raw || `💬 ${truncateTitle(text)}`;
}

// ── Apply title to session ────────────────────────────────────────────────────

function applyTitle(title: string, pi: ExtensionAPI, ctx: ExtensionContext): void {
  try { pi.setSessionName(title); } catch { /* not in all contexts */ }
  try { if (ctx.hasUI) ctx.ui.setTitle(title); } catch { /* not in all contexts */ }
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function sessionTitleExtension(pi: ExtensionAPI): void {
  let titleSet = false;

  const resetOnSessionStart = (_event: any, _ctx: ExtensionContext) => {
    titleSet = pi.getSessionName() !== undefined;
  };

  const handleInput = (event: any, ctx: ExtensionContext) => {
    if (!loadSettings().sessionTitle) return;
    if (titleSet) return;
    titleSet = true;

    const text: string = typeof event.text === "string" ? event.text : "";
    if (!text.trim()) return;

    // Fire-and-forget — don't block the agent
    synthesizeTitle(text, ctx)
      .then(title => applyTitle(title, pi, ctx))
      .catch(() => applyTitle(`💬 ${truncateTitle(text)}`, pi, ctx));
  };

  pi.on("session_start", resetOnSessionStart);
  pi.on("input", handleInput);
}
