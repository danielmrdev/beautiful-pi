import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const name = "@ogulcancelik/pi-codex-compaction";
const expected = require("../../package.json").dependencies[name] as string;
const installed = require("@ogulcancelik/pi-codex-compaction/package.json").version as string;
if (installed !== expected) {
  throw new Error(`Compaction dependency version mismatch: ${name} installed ${installed}, expected ${expected}. Reinstall beautiful-pi dependencies.`);
}

// Pi-codex-compaction currently recognizes only the base provider id. Managed
// beautiful-pi accounts use openai-codex-N, so project only the extension view
// of the model while preserving the original account for auth and checkpoints.
const BASE_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const NATIVE_COMPACTION_KIND = "openai-codex-native-compaction";

interface CodexModel {
  provider: string;
  api: string;
  id: string;
  [key: string]: unknown;
}

function isOpenAICodexModel(model: unknown): model is CodexModel {
  if (!model || typeof model !== "object") return false;
  const candidate = model as Partial<CodexModel>;
  return candidate.api === CODEX_API
    && typeof candidate.id === "string"
    && (candidate.provider === BASE_PROVIDER || /^openai-codex-\d+$/.test(candidate.provider ?? ""));
}

function isManagedCodexModel(model: unknown): model is CodexModel {
  return isOpenAICodexModel(model) && model.provider !== BASE_PROVIDER;
}

// pi-codex-compaction 0.1.6 rebuilds input on checkpoint replay, dropping Pi's
// in-band tool declarations and system updates carried as developer/system items.
function preserveProviderInput(result: any, event: any): any {
  const originalInput = event?.payload?.input;
  if (
    !Array.isArray(originalInput)
    || !result
    || typeof result !== "object"
    || !Array.isArray(result.input)
    || !result.input.some((item: any) => item?.type === "compaction")
  ) {
    return result;
  }

  const providerItems = originalInput.filter(
    (item: any) => item && typeof item === "object" && (item.role === "developer" || item.role === "system"),
  );
  const missingItems = providerItems.filter((item: unknown) => !result.input.includes(item));
  if (missingItems.length === 0) return result;
  return { ...result, input: [...missingItems, ...result.input] };
}

function modelKey(model: CodexModel): string {
  return `${model.provider}:${model.api}:${model.id}`;
}

function baseModelKey(model: CodexModel): string {
  return `${BASE_PROVIDER}:${model.api}:${model.id}`;
}

function withProjectedCheckpoint(entry: any, model: CodexModel): any {
  if (!entry || typeof entry !== "object") return entry;
  const field = entry.type === "compaction" ? "details" : entry.type === "custom" ? "data" : undefined;
  if (!field) return entry;
  const details = entry[field];
  if (!details || typeof details !== "object" || details.kind !== NATIVE_COMPACTION_KIND) {
    return entry;
  }

  const accountKey = modelKey(model);
  const sharedKey = baseModelKey(model);
  let projectedKey = details.modelKey;
  if (projectedKey === accountKey) projectedKey = sharedKey;
  else if (projectedKey === sharedKey) projectedKey = `${sharedKey}:base-account`;
  if (projectedKey === details.modelKey) return entry;

  return { ...entry, [field]: { ...details, modelKey: projectedKey } };
}

function projectBranch(branch: unknown, model: CodexModel): unknown {
  if (!Array.isArray(branch)) return branch;
  return branch.map((entry: any) => {
    const projected = withProjectedCheckpoint(entry, model);
    if (!projected || projected.type !== "message" || !projected.message || typeof projected.message !== "object") {
      return projected;
    }
    const message = projected.message;
    if (message.provider !== model.provider || message.api !== model.api) return projected;
    return {
      ...projected,
      message: { ...message, provider: BASE_PROVIDER },
    };
  });
}

function projectContext(ctx: any, model: CodexModel): any {
  const projectedModel = { ...model, provider: BASE_PROVIDER };
  const sessionManager = ctx.sessionManager;
  const projectedSessionManager = sessionManager && new Proxy(sessionManager, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "getBranch" && typeof value === "function") {
        return (...args: unknown[]) => projectBranch(Reflect.apply(value, target, args), model);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const modelRegistry = ctx.modelRegistry;
  const projectedModelRegistry = modelRegistry && new Proxy(modelRegistry, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "getApiKeyAndHeaders" && typeof value === "function") {
        return (requestedModel: CodexModel, ...args: unknown[]) => {
          const authModel = requestedModel?.provider === BASE_PROVIDER
            && requestedModel.api === model.api
            && requestedModel.id === model.id
            ? model
            : requestedModel;
          return Reflect.apply(value, target, [authModel, ...args]);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return new Proxy(ctx, {
    get(target, property) {
      if (property === "model") return projectedModel;
      if (property === "sessionManager") return projectedSessionManager;
      if (property === "modelRegistry") return projectedModelRegistry;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function preserveAccountCheckpoint(result: any, model: CodexModel): any {
  const details = result?.compaction?.details;
  if (!details || details.kind !== NATIVE_COMPACTION_KIND || details.modelKey !== baseModelKey(model)) {
    return result;
  }
  return {
    ...result,
    compaction: {
      ...result.compaction,
      details: { ...details, modelKey: modelKey(model) },
    },
  };
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
          const managed = isManagedCodexModel(model);
          const projectedEvent = managed && eventName === "session_before_compact" && event?.branchEntries
            ? { ...event, branchEntries: projectBranch(event.branchEntries, model) }
            : event;
          const handlerContext = managed ? projectContext(ctx, model) : ctx;
          const result = handler(projectedEvent, handlerContext, ...rest);

          if (eventName === "before_provider_request" && isOpenAICodexModel(model)) {
            return Promise.resolve(result).then((value) => preserveProviderInput(value, event));
          }
          if (!managed || eventName !== "session_before_compact") return result;
          return Promise.resolve(result).then((value) => preserveAccountCheckpoint(value, model));
        }, ...args]);
    },
  });
}

// Pi's extension loader handles the upstream TypeScript entry point at runtime.
const { default: codexCompaction } = require("@ogulcancelik/pi-codex-compaction/index.ts") as {
  default: (pi: ExtensionAPI) => void;
};

export default function (pi: ExtensionAPI): void {
  codexCompaction(withManagedCodexAccounts(pi));
}
