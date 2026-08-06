/**
 * Fake ExtensionAPI for testing pi extension registration.
 * Only covers methods used by beautiful-pi extensions.
 */
import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSelectionContext, type RotationContext, type RotationState, type SelectionContext } from "./codex-accounts/rotation.ts";
import type { AccountConfig } from "./codex-accounts/types.ts";

interface RecordedEvents extends EventBus {
  get(name: string): Function[] | undefined;
  has(name: string): boolean;
  /** Emit with pi's extension-runner result semantics (last-wins + cancel short-circuit). */
  emitWithResult(name: string, data: unknown, ctx: unknown): Promise<unknown>;
}

export interface FakePi extends ExtensionAPI {
  events: RecordedEvents;
  commands: Map<string, unknown>;
  toolRegistrations: Map<string, unknown>;
}

export function fakePi(): FakePi {
  const handlers = new Map<string, Function[]>();
  const events: RecordedEvents = {
    emit(name: string, data: unknown) {
      for (const handler of handlers.get(name) ?? []) handler(data);
    },
    /**
     * Emit replicating pi's extension-runner result semantics for
     * session-before events (e.g. `session_before_compact`): the last
     * non-undefined handler result wins, and a result with `cancel`
     * short-circuits (later handlers never run). Returns undefined when no
     * handler produced a result.
     *
     * Deliberate divergence from the real runner
     * (dist/core/extensions/runner.js `emit`): handler errors are NOT caught
     * per-handler — a throwing handler propagates instead of being reported
     * and skipped. Tests here rely on that (a throw fails loudly), and
     * last-wins is applied to any event the caller drives, not only
     * session-before events.
     */
    async emitWithResult(name: string, data: unknown, ctx: unknown) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        const handlerResult = await (handler as (d: unknown, c: unknown) => unknown)(data, ctx);
        if (handlerResult) {
          result = handlerResult;
          if ((handlerResult as { cancel?: boolean }).cancel) return result;
        }
      }
      return result;
    },
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => undefined;
    },
    get(name: string) { return handlers.get(name); },
    has(name: string) { return handlers.has(name); },
  };
  const commands = new Map<string, unknown>();
  const toolRegistrations = new Map<string, unknown>();
  return {
    events,
    commands,
    toolRegistrations,
    on(name: string, handler: Function) {
      events.on(name, handler as (data: unknown) => void);
    },
    registerCommand(name: string, config: unknown) { commands.set(name, config); },
    registerEntryRenderer(_kind: string, _renderer: unknown) {},
    registerTool(name: string, _def: unknown, _handler: unknown) {
      toolRegistrations.set(name, true);
    },
    getSessionName() { return undefined; },
    setSessionName(_name: string) {},
  } as any;
}

/**
 * Bundle the selection inputs the way the codex-accounts selection functions
 * expect them. Tests inject a fixed `now` for deterministic cooldown and
 * schedule evaluation.
 */
export function sel(
  cfg: AccountConfig,
  rotCtx: RotationContext,
  state: RotationState,
  now: number,
): SelectionContext {
  return createSelectionContext(cfg, rotCtx, state, now);
}

