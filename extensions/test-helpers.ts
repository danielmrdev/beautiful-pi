/**
 * Fake ExtensionAPI for testing pi extension registration.
 * Only covers methods used by beautiful-pi extensions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FakePi extends ExtensionAPI {
  events: Map<string, Function[]>;
  commands: Map<string, unknown>;
  toolRegistrations: Map<string, unknown>;
}

export function fakePi(): FakePi {
  const events = new Map<string, Function[]>();
  const commands = new Map<string, unknown>();
  const toolRegistrations = new Map<string, unknown>();
  return {
    events,
    commands,
    toolRegistrations,
    on(name: string, handler: Function) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    off(_name: string, _handler: Function) {},
    registerCommand(name: string, config: unknown) { commands.set(name, config); },
    registerTool(name: string, _def: unknown, _handler: unknown) {
      toolRegistrations.set(name, true);
    },
    getSessionName() { return undefined; },
    setSessionName(_name: string) {},
  } as any;
}
