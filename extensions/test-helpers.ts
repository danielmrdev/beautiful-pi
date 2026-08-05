/**
 * Fake ExtensionAPI for testing pi extension registration.
 * Only covers methods used by beautiful-pi extensions.
 */
import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
     * Emit mirroring pi's extension-runner semantics for session-before-
     * events (e.g. `session_before_compact`): the last non-undefined handler
     * result wins, and a result with `cancel` short-circuits (later handlers
     * never run). Returns undefined when no handler produced a result.
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
