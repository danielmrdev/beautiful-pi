import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const name = "pi-blackhole";
const expected = require("../../package.json").dependencies[name] as string;
const installed = require("pi-blackhole/package.json").version as string;
if (installed !== expected) {
  throw new Error(`Compaction dependency version mismatch: ${name} installed ${installed}, expected ${expected}. Reinstall beautiful-pi dependencies.`);
}

interface CodexModel {
  provider: string;
  api: string;
  id: string;
  [key: string]: unknown;
}

function isManagedCodexModel(model: unknown): model is CodexModel {
  if (!model || typeof model !== "object") return false;
  const candidate = model as Partial<CodexModel>;
  return candidate.api === "openai-codex-responses"
    && typeof candidate.id === "string"
    && /^openai-codex-\d+$/.test(candidate.provider ?? "");
}

function withManagedCodexAccounts(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "on" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (eventName: string, handler: Function, ...args: unknown[]) =>
        Reflect.apply(value, target, [eventName, (event: any, ctx: any, ...rest: unknown[]) => {
          const model = ctx?.model;
          if (!isManagedCodexModel(model)) return handler(event, ctx, ...rest);
          // The global skipForProviders entry covers OM/consolidation callbacks.
          // Keep manual/overflow compaction safe even when project config shadows it.
          if (eventName === "session_before_compact") return undefined;
          const projectedContext = new Proxy(ctx, {
            get(context, key) {
              if (key === "model") return { ...model, provider: "openai-codex" };
              const contextValue = Reflect.get(context, key, context);
              return typeof contextValue === "function" ? contextValue.bind(context) : contextValue;
            },
          });
          return handler(event, projectedContext, ...rest);
        }, ...args]);
    },
  });
}

const { default: blackhole } = require("pi-blackhole") as {
  default: (pi: ExtensionAPI) => Promise<void>;
};

export default function (pi: ExtensionAPI): Promise<void> {
  return blackhole(withManagedCodexAccounts(pi));
}
