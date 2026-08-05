/**
 * `/codex` command surface — Codex account lifecycle.
 *
 * Subcommands:
 *   /codex account add [label]      create a new Codex account
 *   /codex account login [ref]      authenticate (or show how)
 *   /codex account logout [ref]     remove the stored credential
 *   /codex account remove [ref]     remove the account configuration entry
 *   /codex account switch [ref]     switch the active model to the account
 *   /codex account list             list accounts with auth status
 *   /codex account status [ref]     detailed status for one account
 *   /codex account migrate          run legacy config migration manually
 *
 * pi owns the OAuth credential store (auth.json) and the login/logout dialogs;
 * this surface registers providers so pi's `/login` can authenticate them and
 * instructs the user for `/logout`. We never write auth.json.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";import {
  loadGlobalAccountConfig,
  saveGlobalAccountConfig,
  addAccount,
  removeAccount,
  setActiveAccount,
  resolveAccount,
  isCredentialAllowed,
  authFilePath,
  agentDirPath,
  storedCredentialIds,
  createPool,
  deletePool,
  setPoolEnabled,
  addPoolMembers,
  removePoolMembers,
  resolvePool,
  listPools,
} from "./store.ts";
import { nextCodexCredentialId, registerAccountProvider, isSuffixedCodexId } from "./provider.ts";
import { getProviderAdapter } from "./registry.ts";
import { runMigration } from "./migration.ts";
import { nextEligibleMember, getSharedRotationState, beginOrContinueRequest, isCooldownActive } from "./rotation.ts";
import { rotationContextFrom } from "./context.ts";
import type { AccountAuthStatus, AccountConfig, CodexAccount, CodexPool } from "./types.ts";

const USAGE = [
  "/codex account <subcommand>",
  "",
  "  add [label]      create a new Codex account",
  "  login [ref]      authenticate the account (shows the /login command)",
  "  logout [ref]     remove the stored credential (shows the /logout command)",
  "  remove [ref]     remove the account configuration entry",
  "  switch [ref]     switch the active model to the account",
  "  list             list accounts with auth status",
  "  status [ref]     detailed status for one account",
  "  migrate          run legacy multi-pass config migration",
  "",
  "/codex pool <subcommand>",
  "",
  "  create <name> <member...>   create a pool from account refs",
  "  list                        list pools with members",
  "  inspect <pool>              per-member eligibility",
  "  enable <pool>               re-enable a pool",
  "  disable <pool>              disable a pool (no rotation/failover)",
  "  delete <pool>               remove the pool",
  "  add <pool> <member...>      add members",
  "  remove <pool> <member...>   remove members",
  "  use <pool>                  round-robin: activate the next eligible member",
].join("\n");

/** Minimal UI shape notify() needs — satisfied by ExtensionCommandContext. */
export interface NotifyContext {
  hasUI?: boolean;
  ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export function notify(ctx: NotifyContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui?.notify(message, type);
}

function sendOutput(pi: ExtensionAPI, lines: string[]): void {
  pi.sendMessage({
    customType: "codex-accounts",
    content: lines.join("\n"),
    display: true,
  }, { triggerTurn: false });
}

/** The referenced account, or the active/first account when no ref is given. */
function pickAccount(cfg: AccountConfig, ref: string | undefined): CodexAccount | undefined {
  if (!ref) {
    const active = cfg.activeAccountId
      ? cfg.accounts.find((a) => a.id === cfg.activeAccountId)
      : cfg.accounts.find((a) => a.active);
    return active ?? cfg.accounts[0];
  }
  return resolveAccount(cfg, ref);
}

function authStatusOf(ctx: ExtensionCommandContext, credentialId: string): AccountAuthStatus {
  try {
    return ctx.modelRegistry.getProviderAuthStatus(credentialId) as AccountAuthStatus;
  } catch {
    return { configured: false };
  }
}

function statusLineOf(ctx: ExtensionCommandContext, account: CodexAccount): string {
  const adapter = getProviderAdapter(account.provider);
  const status = authStatusOf(ctx, account.credentialId);
  const credential = readStoredCredential(account.credentialId, authFilePath());
  return adapter?.statusLine(status, credential) ?? (status.configured ? "authenticated" : "not authenticated");
}

/** Resolve an account for a ref-less command, notifying when none exists. */
function ensureAccount(cfg: AccountConfig, ctx: ExtensionCommandContext, ref: string | undefined): CodexAccount | undefined {
  const account = pickAccount(cfg, ref);
  if (!account) {
    notify(ctx, "No Codex accounts yet. Add one with: /codex account add <label>", "warning");
  }
  return account;
}

function formatAccountRow(ctx: ExtensionCommandContext, account: CodexAccount, activeId?: string): string {
  const active = account.id === activeId || account.active ? "●" : " ";
  return `${active} ${account.label}  [${account.credentialId}]  ${statusLineOf(ctx, account)}`;
}

// ── Subcommands ──────────────────────────────────────────────────────────────

async function cmdAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  let label = rest.trim();
  if (!label && ctx.hasUI) {
    label = (await ctx.ui.input("Account label", "e.g. work, personal"))?.trim() ?? "";
  }
  if (!label) {
    notify(ctx, "Usage: /codex account add <label>", "error");
    return;
  }
  // Avoid colliding with a credential already present in pi's auth store
  // (e.g. created by a manual /login) even when it has no account entry.
  const used = [...cfg.accounts.map((a) => a.credentialId), ...storedCredentialIds()];
  const credentialId = nextCodexCredentialId(used);
  const result = addAccount(cfg, { provider: "openai-codex", credentialId, label });
  saveGlobalAccountConfig(result.cfg);
  if (result.created) {
    registerAccountProvider(ctx.modelRegistry, result.account);
    notify(ctx, `Added Codex account "${label}" as ${credentialId}. Authenticate with: /login ${credentialId}`);
  } else {
    notify(ctx, `Account "${label}" already exists as ${result.account.credentialId}`);
  }
}

async function cmdLogin(ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = ensureAccount(cfg, ctx, ref);
  if (!account) return;
  if (!isCredentialAllowed(ctx.cwd, account.credentialId)) {
    notify(ctx, `Account ${account.credentialId} is restricted in this project`, "warning");
    return;
  }
  const status = authStatusOf(ctx, account.credentialId);
  if (status.configured) {
    notify(ctx, `Account "${account.label}" is already authenticated`);
  } else {
    notify(ctx, `Authenticate "${account.label}" with: /login ${account.credentialId}`);
  }
}

async function cmdLogout(ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = ensureAccount(cfg, ctx, ref);
  if (!account) return;
  const status = authStatusOf(ctx, account.credentialId);
  if (!status.configured) {
    notify(ctx, `Account "${account.label}" is not authenticated`);
    return;
  }
  notify(ctx, `Remove the stored credential with: /logout ${account.credentialId}`);
}

async function cmdRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = pickAccount(cfg, ref);
  if (!account) {
    notify(ctx, "No matching Codex account found", "error");
    return;
  }
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      "Remove Codex account",
      `Remove "${account.label}" (${account.credentialId})? The stored credential stays in pi's auth store.`,
    );
    if (!confirmed) return;
  }
  const next = removeAccount(cfg, account.id);
  saveGlobalAccountConfig(next);
  if (isSuffixedCodexId(account.credentialId)) {
    try {
      ctx.modelRegistry.unregisterProvider(account.credentialId);
    } catch {
      // provider may not be registered
    }
  }
  notify(ctx, `Removed account "${account.label}". Credential still stored — remove it with: /logout ${account.credentialId}`);
}

async function cmdSwitch(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = ensureAccount(cfg, ctx, ref);
  if (!account) return;
  if (!isCredentialAllowed(ctx.cwd, account.credentialId)) {
    notify(ctx, `Account ${account.credentialId} is restricted in this project`, "warning");
    return;
  }
  registerAccountProvider(ctx.modelRegistry, account);
  const models = ctx.modelRegistry
    .getAll()
    .filter((m) => m.provider === account.credentialId);
  const available = models.find((m) => {
    try {
      return ctx.modelRegistry.hasConfiguredAuth(m);
    } catch {
      return false;
    }
  });
  if (!available) {
    notify(ctx, `No models for "${account.label}". Authenticate first with: /login ${account.credentialId}`, "warning");
    return;
  }
  const ok = await pi.setModel(available as Model<any>);
  if (!ok) {
    notify(ctx, `Could not switch to "${account.label}" (no API key available). Authenticate with: /login ${account.credentialId}`, "warning");
    return;
  }
  const next = setActiveAccount(cfg, account.id);
  saveGlobalAccountConfig(next);
  notify(ctx, `Switched to Codex account "${account.label}" (${account.credentialId}, ${available.id})`);
}

async function cmdList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  if (cfg.accounts.length === 0) {
    sendOutput(pi, ["No Codex accounts yet.", "Add one with: /codex account add <label>"]);
    return;
  }
  const activeId = cfg.activeAccountId ?? cfg.accounts.find((a) => a.active)?.id;
  const rows = cfg.accounts.map((a) => formatAccountRow(ctx, a, activeId));
  sendOutput(pi, ["Codex accounts", ...rows, "", "● active  · use /codex account switch <label> to change"]);
}

async function cmdStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = pickAccount(cfg, ref);
  if (!account) {
    sendOutput(pi, ["No matching Codex account found."]);
    return;
  }
  const adapter = getProviderAdapter(account.provider);
  const allowed = isCredentialAllowed(ctx.cwd, account.credentialId);
  const lines = [
    `Account: ${account.label}`,
    `  credential:  ${account.credentialId}`,
    `  provider:    ${adapter?.displayName ?? account.provider}`,
    `  status:      ${statusLineOf(ctx, account)}`,
    `  project:     ${allowed ? "allowed" : "restricted in this project"}`,
    `  created:     ${account.createdAt.slice(0, 10)}`,
    ...(account.lastUsedAt ? [`  last used:   ${account.lastUsedAt.slice(0, 10)}`] : []),
    ...(account.legacy?.index !== undefined ? [`  legacy:      migrated from multi-pass (subscription #${account.legacy.index})`] : account.legacy ? ["  legacy:      migrated from multi-pass"] : []),
    ...(statusLineOf(ctx, account).startsWith("not authenticated") ? [`  next:        /login ${account.credentialId}`] : []),
  ];
  sendOutput(pi, lines);
}

async function cmdMigrate(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const summary = runMigration(agentDirPath(), ctx.cwd, { trusted: ctx.isProjectTrusted() });  const lines = [
    "Legacy multi-pass migration",
    `  global:  ${summary.global}`,
    `  project: ${summary.project}${summary.project === "skipped-untrusted" ? " (project not trusted)" : ""}`,
    ...(summary.accountsCreated > 0 ? [`  accounts created: ${summary.accountsCreated}`] : []),
    ...summary.warnings.map((w) => `  ! ${w}`),
  ];
  sendOutput(pi, lines);
  if (summary.accountsCreated > 0 || summary.warnings.length > 0) {
    notify(ctx, `Migration done: global=${summary.global}, project=${summary.project}`, "info");
  }
}

// ── Pool subcommands ─────────────────────────────────────────────────────────

function poolMemberLabel(cfg: AccountConfig, credentialId: string): string {
  return cfg.accounts.find((a) => a.credentialId === credentialId)?.label ?? credentialId;
}

function poolMemberStatus(ctx: ExtensionCommandContext, cfg: AccountConfig, credentialId: string): string {
  const account = cfg.accounts.find((a) => a.credentialId === credentialId);
  const status = account ? statusLineOf(ctx, account) : "no account entry";
  const restricted = !isCredentialAllowed(ctx.cwd, credentialId);
  const cooling = isCooldownActive(getSharedRotationState(), credentialId);
  return `${status}${cooling ? " · cooling down" : ""}${restricted ? " · restricted in this project" : ""}`;
}

async function cmdPoolCreate(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, ...memberRefs] = tokenize(rest);
  if (!name || memberRefs.length === 0) {
    notify(ctx, "Usage: /codex pool create <name> <member...>  (members are account refs: label, credential id, or id)", "error");
    return;
  }
  const result = createPool(cfg, name, memberRefs);
  if (!result.created) {
    notify(ctx, `Could not create pool: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  const unauthenticated = result.pool!.credentialIds.filter((id) => {
    try {
      return ctx.modelRegistry.getProviderAuthStatus(id)?.configured !== true;
    } catch {
      return true;
    }
  });
  const warn = unauthenticated.length > 0
    ? ` Note: ${unauthenticated.map((id) => poolMemberLabel(result.cfg, id)).join(", ")} not authenticated yet.`
    : "";
  notify(ctx, `Created pool "${name}" with ${result.pool!.credentialIds.length} member(s).${warn}`);
}

async function cmdPoolList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const pools = listPools(cfg);
  if (pools.length === 0) {
    sendOutput(pi, ["No Codex pools yet.", "Create one with: /codex pool create <name> <member...>"]);
    return;
  }
  const rows = pools.map((p) => {
    const members = p.credentialIds.map((id) => poolMemberLabel(cfg, id)).join(", ") || "(empty)";
    return `${p.enabled ? "●" : "○"} ${p.name}  [${p.credentialIds.length} member(s): ${members}]`;
  });
  sendOutput(pi, ["Codex pools", ...rows, "", "● enabled · use /codex pool use <name> to rotate"]);
}

async function cmdPoolInspect(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const pool = resolvePool(cfg, ref);
  if (!pool) {
    sendOutput(pi, [`Pool "${ref}" not found. See: /codex pool list`]);
    return;
  }
  const lines = [
    `Pool: ${pool.name} (${pool.enabled ? "enabled" : "disabled"})`,
    `  cooldown:    ${pool.cooldownSeconds}s after a rate limit`,
    `  next index:  #${pool.lastUsedIndex + 1} (rotation pointer)`,
    "",
    ...(pool.credentialIds.length === 0
      ? ["  (no members — add some with /codex pool add)"]
      : pool.credentialIds.map((id) => `  ${poolMemberLabel(cfg, id)}  [${id}]  ${poolMemberStatus(ctx, cfg, id)}`)),
  ];
  sendOutput(pi, lines);
}

async function cmdPoolSetEnabled(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string, enabled: boolean): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const pool = resolvePool(cfg, ref);
  if (!pool) {
    notify(ctx, `Pool "${ref}" not found. See: /codex pool list`, "error");
    return;
  }
  saveGlobalAccountConfig(setPoolEnabled(cfg, ref, enabled));
  notify(ctx, `Pool "${pool.name}" ${enabled ? "enabled" : "disabled"}`);
}

async function cmdPoolDelete(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const pool = resolvePool(cfg, ref);
  if (!pool) {
    notify(ctx, `Pool "${ref}" not found. See: /codex pool list`, "error");
    return;
  }
  saveGlobalAccountConfig(deletePool(cfg, ref));
  notify(ctx, `Deleted pool "${pool.name}"`);
}

async function cmdPoolAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, ...memberRefs] = tokenize(rest);
  if (!name || memberRefs.length === 0) {
    notify(ctx, "Usage: /codex pool add <pool> <member...>", "error");
    return;
  }
  const result = addPoolMembers(cfg, name, memberRefs);
  if (!result.ok) {
    notify(ctx, `Could not add members: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  const added = result.errors.length === 0
    ? `Added member(s) to pool "${name}"`
    : `Added valid member(s); unknown: ${result.errors.join(", ")}`;
  notify(ctx, added);
}

async function cmdPoolRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, ...memberRefs] = tokenize(rest);
  if (!name || memberRefs.length === 0) {
    notify(ctx, "Usage: /codex pool remove <pool> <member...>", "error");
    return;
  }
  const result = removePoolMembers(cfg, name, memberRefs);
  if (!result.ok) {
    notify(ctx, `Could not remove members: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Removed member(s) from pool "${name}"`);
}

async function cmdPoolUse(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const pool = resolvePool(cfg, ref);
  if (!pool) {
    notify(ctx, `Pool "${ref}" not found. See: /codex pool list`, "error");
    return;
  }
  if (!pool.enabled) {
    notify(ctx, `Pool "${pool.name}" is disabled. Enable with: /codex pool enable ${pool.name}`, "warning");
    return;
  }
  const state = getSharedRotationState();
  beginOrContinueRequest(state, `__pool_use_${Date.now()}`);
  const member = nextEligibleMember(pool, cfg, rotationContextFrom(ctx), state);
  if (!member) {
    notify(
      ctx,
      `No eligible member in pool "${pool.name}". Check authentication (/codex account list) and cooldowns (/codex pool inspect ${pool.name})`,
      "warning",
    );
    return;
  }
  const account = cfg.accounts.find((a) => a.credentialId === member.credentialId)!;
  registerAccountProvider(ctx.modelRegistry, account);
  const models = ctx.modelRegistry.getAll().filter((m) => m.provider === member.credentialId);
  const available = models.find((m) => {
    try {
      return ctx.modelRegistry.hasConfiguredAuth(m);
    } catch {
      return false;
    }
  });
  if (!available) {
    notify(ctx, `No models for "${account.label}". Authenticate first with: /login ${member.credentialId}`, "warning");
    return;
  }
  const ok = await pi.setModel(available as Model<any>);
  if (!ok) {
    notify(ctx, `Could not activate ${account.label} (no API key available). Authenticate with: /login ${member.credentialId}`, "warning");
    return;
  }
  const withPointer: AccountConfig = {
    ...setActiveAccount(cfg, account.id),
    pools: (cfg.pools ?? []).map((p) => (p.id === pool.id ? { ...p, lastUsedIndex: member.index } : p)),
  };
  saveGlobalAccountConfig(withPointer);
  notify(ctx, `Pool "${pool.name}": active member is "${account.label}" (${member.credentialId}, ${available.id})`);
}

// ── Command registration ─────────────────────────────────────────────────────

function tokenize(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

export function registerCodexCommand(pi: ExtensionAPI): void {
  pi.registerCommand("codex", {
    description: "Manage Codex accounts and pools (add, authenticate, switch, rotate, failover)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [section, sub, ...rest] = tokenize(args);
      if (section === "account") {
        const ref = rest.join(" ").trim() || undefined;
        switch (sub) {
          case "add":    await cmdAdd(pi, ctx, rest.join(" ")); break;
          case "login":  await cmdLogin(ctx, ref); break;
          case "logout": await cmdLogout(ctx, ref); break;
          case "remove": await cmdRemove(pi, ctx, ref); break;
          case "switch": await cmdSwitch(pi, ctx, ref); break;
          case "list":   await cmdList(pi, ctx); break;
          case "status": await cmdStatus(pi, ctx, ref); break;
          case "migrate": await cmdMigrate(pi, ctx); break;
          default:
            notify(ctx, USAGE, "info");
        }
        return;
      }
      if (section === "pool") {
        const restArgs = rest.join(" ");
        switch (sub) {
          case "create":  await cmdPoolCreate(pi, ctx, restArgs); break;
          case "list":    await cmdPoolList(pi, ctx); break;
          case "inspect": await cmdPoolInspect(pi, ctx, restArgs.trim()); break;
          case "enable":  await cmdPoolSetEnabled(pi, ctx, restArgs.trim(), true); break;
          case "disable": await cmdPoolSetEnabled(pi, ctx, restArgs.trim(), false); break;
          case "delete":  await cmdPoolDelete(pi, ctx, restArgs.trim()); break;
          case "add":     await cmdPoolAdd(pi, ctx, restArgs); break;
          case "remove":  await cmdPoolRemove(pi, ctx, restArgs); break;
          case "use":     await cmdPoolUse(pi, ctx, restArgs.trim()); break;
          default:
            notify(ctx, USAGE, "info");
        }
        return;
      }
      notify(ctx, USAGE, "info");
    },
  });
}
