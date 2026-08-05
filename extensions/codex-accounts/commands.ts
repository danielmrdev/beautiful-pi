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
import type { AutocompleteItem } from "@earendil-works/pi-tui";
// Node builtins follow the repo convention: require(), not import.
const { exec } = require("node:child_process") as typeof import("node:child_process");
import {
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
  setPoolStrategy,
  setPoolSchedule,
  clearPoolSchedule,
  setPoolSelector,
  clearPoolSelector,
} from "./store.ts";
import { nextCodexCredentialId, registerAccountProvider, isSuffixedCodexId, activateAccountModel, findAccountModel } from "./provider.ts";
import { getProviderAdapter } from "./registry.ts";
import { runMigration } from "./migration.ts";
import { nextEligibleMember, getSharedRotationState, beginNewRequest, isCooldownActive, type EligibleMember, type RotationContext, type RotationState } from "./rotation.ts";
import { rotationContextFrom } from "./context.ts";
import {
  WEEKDAYS,
  WEEKEND,
  eligibleMembers,
  isScheduleActive,
  resolveCustomSelection,
  selectQuotaFirst,
  selectScheduled,
} from "./strategies.ts";
import { fetchAccountQuotaReport, formatAccountQuota, formatUnavailableReason } from "./quota.ts";
import { DATE_RE, TIME_RE, WINDOW_RE } from "./schedule.ts";
import { chainTargetStatus, memberUnavailableReason, walkChain, type ChainWalkResult } from "./chain.ts";
import {
  createChain,
  deleteChain,
  setChainEnabled,
  addChainTargets,
  removeChainTargets,
  resolveChain,
  resolvePoolById,
  createPreset,
  deletePreset,
  setPresetEnabled,
  resolvePreset,
  resolveTargetRef,
  loadProjectAccountConfig,
  saveProjectAccountConfig,
  resolveEffectiveConfig,
  sameTarget,
} from "./store.ts";
import type { AccountAuthStatus, AccountConfig, ChainTarget, CodexAccount, CodexChain, CodexPool, CodexPreset, PoolSchedule } from "./types.ts";

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
  "  quota [ref]      inspect quota windows (5h/7d usage) per account",
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
  "  use <pool>                  select a member (round-robin, quota-first, scheduled, or custom)",
  "  strategy <pool> <round-robin|quota-first|scheduled|custom>",
  "  schedule <pool> [<HH:MM-HH:MM>,...] [days <spec>] [from <date>] [to <date>] [roles <member>=<role> ...]",
  "  schedule clear <pool>       remove the schedule",
  "  selector <pool> <command>   custom member selector (outputs a member ref)",
  "  selector clear <pool>       remove the selector",
  "",
  "days <spec>: everyday | weekdays | weekend | sun,mon,... | mon-fri ranges",
  "roles: <member>=<primary|backup>  (backup members used when no primary is eligible)",
  "",
  "/codex chain <subcommand>",
  "",
  "  create <name> <target...>   ordered fallback chain (targets: pool or account refs)",
  "  list                        list chains with targets",
  "  inspect <chain>             per-target eligibility",
  "  use <chain>                 walk targets (each pool uses its strategy) and activate",
  "  enable <chain> / disable <chain>",
  "  delete <chain>              remove the chain",
  "  add <chain> <target...>     append targets",
  "  remove <chain> <target...>  remove targets",
  "",
  "/codex preset <subcommand>",
  "",
  "  create <name> <pool> [model <prefix>]   named routing preset",
  "  list / inspect <preset>",
  "  activate <preset>          resolve the best eligible member and switch to it",
  "  enable <preset> / disable <preset> / delete <preset>",
  "",
  "/codex project <subcommand>   (trusted projects only; stored in .pi/beautiful-pi.json)",
  "",
  "  allow <account...>         restrict this project to the given accounts",
  "  allow all                  clear the project account restriction",
  "  pool <name> <member...>    override a global pool's members for this project",
  "  pool enable|disable|clear <name>",
  "  chain <name> <target...>   override a global chain's targets for this project",
  "  chain enable|disable|clear <name>",
  "  show                       effective (global + project) config",
].join("\n");

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
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
  const model = await activateAccountModel(pi, ctx.modelRegistry, account);
  if (!model) {
    notify(ctx, `No models for "${account.label}". Authenticate first with: /login ${account.credentialId}`, "warning");
    return;
  }
  const next = setActiveAccount(cfg, account.id);
  saveGlobalAccountConfig(next);
  notify(ctx, `Switched to Codex account "${account.label}" (${account.credentialId}, ${model.id})`);
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

async function cmdAccountQuota(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  if (cfg.accounts.length === 0) {
    sendOutput(pi, ["No Codex accounts yet.", "Add one with: /codex account add <label>"]);
    return;
  }
  const accounts = ref ? [pickAccount(cfg, ref)].filter((a): a is CodexAccount => !!a) : cfg.accounts;
  if (accounts.length === 0) {
    sendOutput(pi, ["No matching Codex account found."]);
    return;
  }
  const lines = ["Codex quota — supported windows: 5h (primary), 7d (secondary)"];
  const allowed = accounts.filter((a) => isCredentialAllowed(ctx.cwd, a.credentialId));
  for (const account of accounts) {
    if (!isCredentialAllowed(ctx.cwd, account.credentialId)) {
      lines.push(`  ${account.label}  [${account.credentialId}]  restricted in this project`);
    }
  }
  // Fetch allowed accounts in parallel; each fetch has its own timeout.
  const reports = await Promise.all(allowed.map((a) => fetchAccountQuotaReport(a)));
  for (const report of reports) {
    const { account } = report;
    if (report.quota) {
      lines.push(`  ${account.label}  [${account.credentialId}]  ${formatAccountQuota(report.quota)}`);
    } else {
      lines.push(`  ${account.label}  [${account.credentialId}]  unavailable: ${formatUnavailableReason(report.unavailableReason!)}`);
    }
  }
  sendOutput(pi, lines);
}

async function cmdMigrate(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const summary = runMigration(agentDirPath(), ctx.cwd, { trusted: ctx.isProjectTrusted() });
  const lines = [
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
  const rotCtx = rotationContextFrom(ctx);
  const restricted = !rotCtx.allowed(credentialId);
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
  // AC2: unavailable (unauthenticated) members are rejected, not admitted.
  const rotCtx = rotationContextFrom(ctx);
  const unauthenticated = result.pool!.credentialIds.filter((id) => !rotCtx.authConfigured(id));
  if (unauthenticated.length > 0) {
    const labels = unauthenticated.map((id) => poolMemberLabel(result.cfg, id)).join(", ");
    saveGlobalAccountConfig(deletePool(result.cfg, name));
    notify(ctx, `Could not create pool: ${labels} not authenticated yet. Authenticate with: /login <credentialId>`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Created pool "${name}" with ${result.pool!.credentialIds.length} member(s)`);
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
  const cfg = loadEffective(ctx);
  const pool = resolvePool(cfg, ref);
  if (!pool) {
    sendOutput(pi, [`Pool "${ref}" not found. See: /codex pool list`]);
    return;
  }
  const lines = [
    `Pool: ${pool.name} (${pool.enabled ? "enabled" : "disabled"})`,
    `  cooldown:    ${pool.cooldownSeconds}s after a rate limit`,
    `  next index:  #${pool.lastUsedIndex + 1} (rotation pointer)`,
    `  strategy:    ${pool.strategy ?? "round-robin"}`,
    ...(pool.schedule ? [`  schedule:    ${summarizeSchedule(pool.schedule)}`] : []),
    ...(pool.selector ? [`  selector:    ${pool.selector}`] : []),
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
  // AC2: newly added members must be available (authenticated).
  const rotCtx = rotationContextFrom(ctx);
  const unauthenticated = memberRefs
    .map((ref) => resolveAccount(result.cfg, ref.trim()))
    .filter((a): a is CodexAccount => !!a)
    .filter((a) => !rotCtx.authConfigured(a.credentialId))
    .map((a) => a.credentialId);
  if (unauthenticated.length > 0) {
    const rollback = removePoolMembers(result.cfg, name, unauthenticated);
    saveGlobalAccountConfig(rollback.cfg);
    notify(ctx, `Could not add members: ${unauthenticated.join(", ")} not authenticated yet. Authenticate with: /login <credentialId>`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Added member(s) to pool "${name}"`);
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
  const cfg = loadEffective(ctx);
  const global = loadGlobalAccountConfig();
  const pool = resolvePool(cfg, ref);
  if (!pool) {
    notify(ctx, `Pool "${ref}" not found. See: /codex pool list`, "error");
    return;
  }
  if (!pool.enabled) {
    notify(ctx, `Pool "${pool.name}" is disabled. Enable with: /codex pool enable ${pool.name}`, "warning");
    return;
  }
  const rotCtx = rotationContextFrom(ctx);
  const state = getSharedRotationState();
  beginNewRequest(state);
  const member = await selectForStrategy(pool, cfg, rotCtx, state, ctx);
  if (!member) {
    notify(
      ctx,
      `No eligible member in pool "${pool.name}". Check authentication (/codex account list) and cooldowns (/codex pool inspect ${pool.name})`,
      "warning",
    );
    return;
  }
  const account = cfg.accounts.find((a) => a.credentialId === member.credentialId)!;
  const model = await activateAccountModel(pi, ctx.modelRegistry, account);
  if (!model) {
    notify(ctx, `No models for "${account.label}". Authenticate first with: /login ${member.credentialId}`, "warning");
    return;
  }
  const withPointer: AccountConfig = {
    ...setActiveAccount(global, account.id),
    pools: poolPointerPersists(global, pool.id, pool.credentialIds)
      ? (global.pools ?? []).map((p) => (p.id === pool.id ? { ...p, lastUsedIndex: member.index } : p))
      : (global.pools ?? []),
  };
  saveGlobalAccountConfig(withPointer);
  notify(ctx, `Pool "${pool.name}": active member is "${account.label}" (${member.credentialId}, ${model.id})`);
}

// ── Strategy selection ───────────────────────────────────────────────────────

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const DAY_NUM_TO_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(DAY_NAMES).map(([name, num]) => [num, name]),
);

/**
 * Pick a pool member according to the pool's strategy. Every strategy degrades
 * to deterministic round-robin when its specialized data is unavailable;
 * quota-first fetches live quota for the eligible set (network failures and
 * missing credentials simply exclude a member from the healthiest ranking).
 * `members` narrows the eligible set (preset model filtering); when absent
 * the pool's full eligible scan is used.
 */
async function selectForStrategy(
  pool: CodexPool,
  cfg: AccountConfig,
  rotCtx: RotationContext,
  state: RotationState,
  ctx: ExtensionCommandContext,
  members?: EligibleMember[],
): Promise<EligibleMember | undefined> {
  const strategy = pool.strategy ?? "round-robin";
  const eligible = () => members ?? eligibleMembers(pool, cfg, rotCtx, state);
  if (strategy === "quota-first") {
    const list = eligible();
    const reports = await Promise.all(
      list.map((m) => fetchAccountQuotaReport(cfg.accounts.find((a) => a.credentialId === m.credentialId)!)),
    );
    const quotaOf = (id: string) => reports.find((r) => r.account.credentialId === id)?.quota;
    // Pass the already-scanned members so the selector doesn't rescan.
    const member = selectQuotaFirst(pool, cfg, rotCtx, state, quotaOf, Date.now(), list);
    if (member) {
      const withData = reports.filter((r) => r.quota);
      const noData = withData.length === 0;
      const allExhausted = withData.length > 0 && withData.every((r) => r.quota!.status === "exhausted");
      if (noData) {
        notify(ctx, `Pool "${pool.name}": no quota data available — fell back to round-robin`, "warning");
      } else if (allExhausted) {
        notify(ctx, `Pool "${pool.name}": every account is at quota — fell back to round-robin`, "warning");
      }
    }
    return member;
  }
  if (strategy === "scheduled") {
    const now = new Date();
    const member = selectScheduled(pool, cfg, rotCtx, state, pool.schedule, now, eligible());
    if (member && !isScheduleActive(pool.schedule, now)) {
      notify(ctx, `Pool "${pool.name}": schedule inactive — using round-robin`, "warning");
    }
    return member;
  }
  if (strategy === "custom") {
    if (!pool.selector) {
      notify(ctx, `Pool "${pool.name}": no selector configured — using round-robin (set one with /codex pool selector)`, "warning");
      return eligible()[0];
    }
    const list = eligible();
    const refOut = await execSelector(pool.selector, {
      pool: { name: pool.name, credentialIds: pool.credentialIds },
      eligible: list.map((m) => m.credentialId),
      now: new Date().toISOString(),
    });
    const member = resolveCustomSelection(pool, cfg, rotCtx, state, refOut);
    if (member) return member;
    const reason = refOut
      ? `selector returned an ineligible member ("${refOut}")`
      : "selector produced no usable member";
    notify(ctx, `Pool "${pool.name}": ${reason} — using round-robin`, "warning");
    return list[0];
  }
  return eligible()[0];
}

/** Run the custom selector shell command; resolves with its first stdout line. */
function execSelector(selector: string, input: unknown): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const child = exec(selector, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(undefined);
        const line = stdout.trim().split(/\r?\n/)[0]?.trim();
        resolve(line || undefined);
      });
      const stdin = child.stdin;
      if (stdin) {
        // Selectors may ignore stdin (e.g. `echo`); a closed pipe must not crash.
        stdin.on("error", () => {});
        try {
          stdin.end(JSON.stringify(input));
        } catch {
          // stdin already closed
        }
      }
    } catch {
      resolve(undefined);
    }
  });
}

async function cmdPoolStrategy(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, strategy, ...extra] = tokenize(rest);
  if (!name || !strategy || extra.length > 0) {
    notify(ctx, "Usage: /codex pool strategy <pool> <round-robin|quota-first|scheduled|custom>", "error");
    return;
  }
  if (!resolvePool(cfg, name)) {
    notify(ctx, `Pool "${name}" not found. See: /codex pool list`, "error");
    return;
  }
  const result = setPoolStrategy(cfg, name, strategy);
  if (!result.ok) {
    notify(ctx, `Could not set strategy: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Pool "${name}" strategy: ${strategy}`);
  const saved = resolvePool(result.cfg, name)!;
  if (strategy === "scheduled" && !saved.schedule) {
    notify(ctx, `Pool "${name}" has no schedule yet — it will use round-robin until you run: /codex pool schedule ${name} <HH:MM-HH:MM>`, "warning");
  }
  if (strategy === "custom" && !saved.selector) {
    notify(ctx, `Pool "${name}" has no selector yet — it will use round-robin until you run: /codex pool selector ${name} <command>`, "warning");
  }
}

async function cmdPoolSchedule(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const tokens = tokenize(rest);
  if (tokens.length === 0) {
    notify(ctx, "Usage: /codex pool schedule <pool> [<HH:MM-HH:MM>,...] [days <spec>] [from <date>] [to <date>] [roles <member>=<role> ...]", "error");
    return;
  }
  // Accept both "schedule clear <pool>" and "schedule <pool> clear".
  const clear = tokens.some((t) => t.toLowerCase() === "clear");
  const name = tokens.find((t) => t.toLowerCase() !== "clear");
  if (!name) {
    notify(ctx, "Usage: /codex pool schedule clear <pool>", "error");
    return;
  }
  const pool = resolvePool(cfg, name);
  if (!pool) {
    notify(ctx, `Pool "${name}" not found. See: /codex pool list`, "error");
    return;
  }
  if (clear) {
    const cleared = clearPoolSchedule(cfg, name);
    if (!cleared.ok) {
      notify(ctx, `Could not clear schedule: ${cleared.errors.join("; ")}`, "error");
      return;
    }
    saveGlobalAccountConfig(cleared.cfg);
    notify(ctx, `Cleared schedule for pool "${pool.name}"`);
    return;
  }
  const parsed = parseScheduleArgs(pool, cfg, tokens.filter((t) => t !== name));
  if (!parsed.schedule || parsed.errors.length > 0) {
    notify(ctx, `Could not set schedule: ${parsed.errors.join("; ")}`, "error");
    return;
  }
  const result = setPoolSchedule(cfg, name, parsed.schedule);
  if (!result.ok) {
    notify(ctx, `Could not set schedule: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Schedule for pool "${pool.name}": ${summarizeSchedule(parsed.schedule)}`);
}

async function cmdPoolSelector(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const tokens = tokenize(rest);
  if (tokens.length === 0) {
    notify(ctx, "Usage: /codex pool selector <pool> <command...>  (or: /codex pool selector clear <pool>)", "error");
    return;
  }
  // Clear form is unambiguous: "selector clear <pool>".
  if (tokens[0].toLowerCase() === "clear") {
    const name = tokens[1];
    if (!name) {
      notify(ctx, "Usage: /codex pool selector clear <pool>", "error");
      return;
    }
    const pool = resolvePool(cfg, name);
    if (!pool) {
      notify(ctx, `Pool "${name}" not found. See: /codex pool list`, "error");
      return;
    }
    saveGlobalAccountConfig(clearPoolSelector(cfg, name).cfg);
    notify(ctx, `Cleared selector for pool "${pool.name}"`);
    return;
  }
  const [name, ...command] = tokens;
  const pool = resolvePool(cfg, name);
  if (!pool) {
    notify(ctx, `Pool "${name}" not found. See: /codex pool list`, "error");
    return;
  }
  if (command.length === 0) {
    notify(ctx, "Usage: /codex pool selector <pool> <command...>", "error");
    return;
  }
  const result = setPoolSelector(cfg, name, command.join(" "));
  if (!result.ok) {
    notify(ctx, `Could not set selector: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  const saved = resolvePool(result.cfg, name)!;
  notify(ctx, `Custom selector for pool "${pool.name}": ${saved.selector}`);
}

function parseDayToken(token: string): number[] | undefined {
  const t = token.toLowerCase();
  if (t === "everyday") return [];
  if (t === "weekdays") return [...WEEKDAYS];
  if (t === "weekend") return [...WEEKEND];
  const range = /^([a-z]{3})-([a-z]{3})$/.exec(t);
  if (range) {
    const a = DAY_NAMES[range[1]];
    const b = DAY_NAMES[range[2]];
    if (a === undefined || b === undefined) return undefined;
    if (a <= b) return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    return [...Array.from({ length: 7 - a }, (_, i) => a + i), ...Array.from({ length: b + 1 }, (_, i) => i)];
  }
  const single = DAY_NAMES[t];
  return single !== undefined ? [single] : undefined;
}

/** Parse `[<HH:MM-HH:MM>,...] [days <spec>] [from <date>] [to <date>] [roles <member>=<role> ...]`. */
function parseScheduleArgs(
  pool: CodexPool,
  cfg: AccountConfig,
  tokens: string[],
): { schedule?: PoolSchedule; errors: string[] } {
  const schedule: PoolSchedule = {};
  const errors: string[] = [];
  let i = 0;
  if (i < tokens.length && /^\d{2}:\d{2}-\d{2}:\d{2}/.test(tokens[i])) {
    const windows: Array<{ start: string; end: string }> = [];
    for (const w of tokens[i].split(",")) {
      const match = WINDOW_RE.exec(w);
      if (!match || !TIME_RE.test(match[1]) || !TIME_RE.test(match[2])) {
        errors.push(`invalid time window "${w}" (HH:MM-HH:MM)`);
        return { schedule: undefined, errors };
      }
      windows.push({ start: match[1], end: match[2] });
    }
    schedule.timeWindows = windows;
    i++;
  }
  while (i < tokens.length) {
    const kw = tokens[i].toLowerCase();
    if (kw === "days") {
      i++;
      const days: number[] = [];
      while (i < tokens.length && !["from", "to", "roles"].includes(tokens[i].toLowerCase())) {
        for (const part of tokens[i].split(",")) {
          const parsed = parseDayToken(part);
          if (!parsed) {
            errors.push(`unknown day "${part}" (sun..sat, mon-fri, weekdays, weekend, everyday)`);
            return { schedule: undefined, errors };
          }
          days.push(...parsed);
        }
        i++;
      }
      if (days.length > 0) schedule.days = [...new Set(days)].sort();
    } else if (kw === "from" || kw === "to") {
      const date = tokens[i + 1];
      if (!date || !DATE_RE.test(date)) {
        errors.push(`invalid date after "${kw}" (YYYY-MM-DD)`);
        return { schedule: undefined, errors };
      }
      schedule.dateRange = { ...schedule.dateRange, [kw === "from" ? "start" : "end"]: date };
      i += 2;
    } else if (kw === "roles") {
      i++;
      const memberRoles: Record<string, "primary" | "backup"> = {};
      while (i < tokens.length) {
        const pair = tokens[i];
        const eq = pair.indexOf("=");
        if (eq <= 0) {
          errors.push(`invalid role "${pair}" (member=primary|backup)`);
          return { schedule: undefined, errors };
        }
        const account = resolveAccount(cfg, pair.slice(0, eq));
        const role = pair.slice(eq + 1).toLowerCase();
        if (!account) {
          errors.push(`unknown member "${pair.slice(0, eq)}"`);
          return { schedule: undefined, errors };
        }
        if (!pool.credentialIds.includes(account.credentialId)) {
          errors.push(`"${pair.slice(0, eq)}" is not a member of pool "${pool.name}"`);
          return { schedule: undefined, errors };
        }
        if (role !== "primary" && role !== "backup") {
          errors.push(`invalid role "${pair.slice(eq + 1)}" (primary|backup)`);
          return { schedule: undefined, errors };
        }
        memberRoles[account.credentialId] = role;
        i++;
      }
      if (Object.keys(memberRoles).length > 0) schedule.memberRoles = memberRoles;
    } else {
      errors.push(`unexpected token "${tokens[i]}"`);
      return { schedule: undefined, errors };
    }
  }
  if (Object.keys(schedule).length === 0) {
    errors.push("no schedule constraints given (e.g. 09:00-17:00, days mon-fri)");
    return { schedule: undefined, errors };
  }
  return { schedule, errors };
}

function summarizeSchedule(schedule: PoolSchedule): string {
  const parts: string[] = [];
  if (schedule.timeWindows?.length) parts.push(schedule.timeWindows.map((w) => `${w.start}-${w.end}`).join(","));
  if (schedule.days?.length) parts.push("on " + schedule.days.map((d) => DAY_NUM_TO_NAME[d] ?? "?").join(","));
  if (schedule.dateRange?.start) parts.push(`from ${schedule.dateRange.start}`);
  if (schedule.dateRange?.end) parts.push(`to ${schedule.dateRange.end}`);
  if (schedule.memberRoles) {
    const roles = Object.entries(schedule.memberRoles).map(([id, role]) => `${id}=${role}`).join(", ");
    parts.push(`roles ${roles}`);
  }
  return parts.join(" ") || "(always active)";
}

// ── Chain / preset / project commands ────────────────────────────────────────

/** Effective config: global merged with trusted project overrides. */
function loadEffective(ctx: ExtensionCommandContext): AccountConfig {
  const global = loadGlobalAccountConfig();
  if (!ctx.isProjectTrusted()) return global;
  const project = loadProjectAccountConfig(ctx.cwd);
  return project ? resolveEffectiveConfig(global, project) : global;
}

/**
 * True when the pool's member list is unchanged by a project override, so a
 * member index computed on it can be persisted to the global pool pointer.
 * Overridden pools keep their pointer untouched (rotation restarts fresh per
 * request — the attempted set still guards replays).
 */
function poolPointerPersists(global: AccountConfig, poolId: string, memberIds: string[]): boolean {
  const pool = (global.pools ?? []).find((p) => p.id === poolId);
  return !!pool && pool.credentialIds.join("\u0000") === memberIds.join("\u0000");
}

/** True when the chain's targets are unchanged by a project override. */
function chainProgressPersists(global: AccountConfig, chainId: string, targets: ChainTarget[]): boolean {
  const chain = (global.chains ?? []).find((c) => c.id === chainId);
  if (!chain || chain.targets.length !== targets.length) return false;
  return chain.targets.every((t, i) => sameTarget(t, targets[i]));
}

/**
 * Walk a chain with strategy-aware selection: pool targets pick through the
 * pool's own strategy (quota-first/scheduled/custom/round-robin), account
 * targets are used directly. Skipped targets never break the walk. Shares the
 * walk skeleton with failover replay via chain.ts `walkChain`.
 */
async function selectChainMember(
  chain: CodexChain,
  cfg: AccountConfig,
  rotCtx: RotationContext,
  state: RotationState,
  ctx: ExtensionCommandContext,
): Promise<ChainWalkResult | undefined> {
  return walkChain(chain, cfg, rotCtx, state, Date.now(), (pool, cfg2, ctx2, state2) =>
    selectForStrategy(pool, cfg2, ctx2, state2, ctx),
  );
}

function targetLabel(cfg: AccountConfig, target: ChainTarget): string {
  if (target.kind === "pool") return resolvePoolById(cfg, target.poolId)?.name ?? target.poolId;
  return poolMemberLabel(cfg, target.credentialId);
}

async function cmdChainCreate(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, ...refs] = tokenize(rest);
  if (!name || refs.length === 0) {
    notify(ctx, "Usage: /codex chain create <name> <target...>  (targets: pool or account refs)", "error");
    return;
  }
  const result = createChain(cfg, name, refs);
  if (!result.created) {
    notify(ctx, `Could not create chain: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Created chain "${name}" with ${result.chain!.targets.length} target(s)`);
}

async function cmdChainList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const cfg = loadEffective(ctx);
  const chains = cfg.chains ?? [];
  if (chains.length === 0) {
    sendOutput(pi, ["No Codex chains yet.", "Create one with: /codex chain create <name> <pool|account>..."]);
    return;
  }
  const rows = chains.map((c) => {
    const targets = c.targets.map((t) => targetLabel(cfg, t)).join(" -> ") || "(no targets)";
    return `${c.enabled ? "●" : "○"} ${c.name}  [${targets}]`;
  });
  sendOutput(pi, ["Codex chains", ...rows, "", "● enabled · use /codex chain use <name> to walk"]);
}

async function cmdChainInspect(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadEffective(ctx);
  const chain = resolveChain(cfg, ref);
  if (!chain) {
    sendOutput(pi, [`Chain "${ref}" not found. See: /codex chain list`]);
    return;
  }
  const rotCtx = rotationContextFrom(ctx);
  const state = getSharedRotationState();
  const lines = [
    `Chain: ${chain.name} (${chain.enabled ? "enabled" : "disabled"})`,
    `  progress:  target #${Math.max(chain.lastUsedTargetIndex, 0)} (replay pointer)`,
    "",
    ...(chain.targets.length === 0
      ? ["  (no targets — add some with /codex chain add)"]
      : chain.targets.map(
          (t, i) => `  ${i + 1}. ${targetLabel(cfg, t)}  ${chainTargetStatus(t, cfg, rotCtx, state)}`,
        )),
  ];
  sendOutput(pi, lines);
}

async function cmdChainSetEnabled(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string, enabled: boolean): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const chain = resolveChain(cfg, ref);
  if (!chain) {
    notify(ctx, `Chain "${ref}" not found. See: /codex chain list`, "error");
    return;
  }
  saveGlobalAccountConfig(setChainEnabled(cfg, ref, enabled).cfg);
  notify(ctx, `Chain "${chain.name}" ${enabled ? "enabled" : "disabled"}`);
}

async function cmdChainDelete(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const chain = resolveChain(cfg, ref);
  if (!chain) {
    notify(ctx, `Chain "${ref}" not found. See: /codex chain list`, "error");
    return;
  }
  saveGlobalAccountConfig(deleteChain(cfg, ref));
  notify(ctx, `Deleted chain "${chain.name}"`);
}

async function cmdChainAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, ...refs] = tokenize(rest);
  if (!name || refs.length === 0) {
    notify(ctx, "Usage: /codex chain add <chain> <target...>", "error");
    return;
  }
  const result = addChainTargets(cfg, name, refs);
  if (!result.ok) {
    notify(ctx, `Could not add targets: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Added target(s) to chain "${name}"`);
}

async function cmdChainRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const [name, ...refs] = tokenize(rest);
  if (!name || refs.length === 0) {
    notify(ctx, "Usage: /codex chain remove <chain> <target...>", "error");
    return;
  }
  const result = removeChainTargets(cfg, name, refs);
  if (!result.ok) {
    notify(ctx, `Could not remove targets: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Removed target(s) from chain "${name}"`);
}

async function cmdChainUse(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadEffective(ctx);
  const global = loadGlobalAccountConfig();
  const chain = resolveChain(cfg, ref);
  if (!chain) {
    notify(ctx, `Chain "${ref}" not found. See: /codex chain list`, "error");
    return;
  }
  if (!chain.enabled) {
    notify(ctx, `Chain "${chain.name}" is disabled. Enable with: /codex chain enable ${chain.name}`, "warning");
    return;
  }
  const rotCtx = rotationContextFrom(ctx);
  const state = getSharedRotationState();
  beginNewRequest(state);
  // A fresh walk starts from the first target; replay progress only persists
  // through failover (nextChainMember), which continues from the pointer.
  const walk = await selectChainMember({ ...chain, lastUsedTargetIndex: -1 }, cfg, rotCtx, state, ctx);
  if (!walk) {
    notify(ctx, `No eligible member in chain "${chain.name}". Check /codex chain inspect ${chain.name}`, "warning");
    return;
  }
  const account = cfg.accounts.find((a) => a.credentialId === walk.member.credentialId)!;
  const model = await activateAccountModel(pi, ctx.modelRegistry, account);
  if (!model) {
    notify(ctx, `No models for "${account.label}". Authenticate first with: /login ${walk.member.credentialId}`, "warning");
    return;
  }
  const withProgress: AccountConfig = {
    ...setActiveAccount(global, account.id),
    // Progress only persists when the pool/chain came from the global config;
    // project overrides keep their own (unindexed) rotation.
    chains: chainProgressPersists(global, chain.id, chain.targets)
      ? (global.chains ?? []).map((c) =>
          c.id === chain.id ? { ...c, lastUsedTargetIndex: walk.targetIndex } : c
        )
      : (global.chains ?? []),
    pools: walk.pool && poolPointerPersists(global, walk.pool.id, walk.pool.credentialIds)
      ? (global.pools ?? []).map((p) =>
          p.id === walk.pool!.id ? { ...p, lastUsedIndex: walk.member.index } : p
        )
      : (global.pools ?? []),
  };
  saveGlobalAccountConfig(withProgress);
  const skippedNote = walk.skipped.length ? ` (skipped: ${walk.skipped.join("; ")})` : "";
  notify(ctx, `Chain "${chain.name}": active member is "${account.label}" (${walk.member.credentialId}, ${model.id})${skippedNote}`);
}

// ── Preset commands ──────────────────────────────────────────────────────────

async function cmdPresetCreate(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const tokens = tokenize(rest);
  const [name, poolRef] = tokens;
  const modelIdx = tokens.indexOf("model");
  const model = modelIdx !== -1 && modelIdx < tokens.length - 1 ? tokens[modelIdx + 1] : undefined;
  if (!name || !poolRef) {
    notify(ctx, "Usage: /codex preset create <name> <pool> [model <prefix>]", "error");
    return;
  }
  const result = createPreset(cfg, name, poolRef, model);
  if (!result.created) {
    notify(ctx, `Could not create preset: ${result.errors.join("; ")}`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  notify(ctx, `Created preset "${name}" on pool "${poolRef}"${model ? ` (model ${model})` : ""}`);
}

async function cmdPresetList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const cfg = loadEffective(ctx);
  const presets = cfg.presets ?? [];
  if (presets.length === 0) {
    sendOutput(pi, ["No Codex presets yet.", "Create one with: /codex preset create <name> <pool>"]);
    return;
  }
  const rows = presets.map((p) => {
    const pool = resolvePoolById(cfg, p.poolId);
    return `${p.enabled ? "●" : "○"} ${p.name}  -> pool ${pool?.name ?? p.poolId}${p.model ? ` (model ${p.model})` : ""}`;
  });
  sendOutput(pi, ["Codex presets", ...rows, "", "● enabled · use /codex preset activate <name> to switch"]);
}

async function cmdPresetInspect(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadEffective(ctx);
  const preset = resolvePreset(cfg, ref);
  if (!preset) {
    sendOutput(pi, [`Preset "${ref}" not found. See: /codex preset list`]);
    return;
  }
  const pool = resolvePoolById(cfg, preset.poolId);
  const rotCtx = rotationContextFrom(ctx);
  const state = getSharedRotationState();
  const lines = [
    `Preset: ${preset.name} (${preset.enabled ? "enabled" : "disabled"})`,
    `  pool:      ${pool?.name ?? preset.poolId}${pool ? ` (strategy ${pool.strategy ?? "round-robin"})` : " — not found"}`,
    ...(preset.model ? [`  model:     ${preset.model}`] : []),
    `  created:   ${preset.createdAt.slice(0, 10)}`,
    ...(pool ? ["", ...pool.credentialIds.map((id) => `  ${poolMemberLabel(cfg, id)}  [${id}]  ${poolMemberStatus(ctx, cfg, id)}`)] : []),
  ];
  sendOutput(pi, lines);
}

async function cmdPresetActivate(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadEffective(ctx);
  const global = loadGlobalAccountConfig();
  const preset = resolvePreset(cfg, ref);
  if (!preset) {
    notify(ctx, `Preset "${ref}" not found. See: /codex preset list`, "error");
    return;
  }
  if (!preset.enabled) {
    notify(ctx, `Preset "${preset.name}" is disabled. Enable with: /codex preset enable ${preset.name}`, "warning");
    return;
  }
  const pool = resolvePoolById(cfg, preset.poolId);
  if (!pool) {
    notify(ctx, `Preset "${preset.name}" references a missing pool — recreate it with /codex preset create`, "error");
    return;
  }
  if (!pool.enabled) {
    notify(ctx, `Pool "${pool.name}" is disabled. Enable with: /codex pool enable ${pool.name}`, "warning");
    return;
  }
  const rotCtx = rotationContextFrom(ctx);
  const state = getSharedRotationState();
  beginNewRequest(state);
  let member = await selectForStrategy(pool, cfg, rotCtx, state, ctx);
  let account = member ? cfg.accounts.find((a) => a.credentialId === member!.credentialId) : undefined;
  let model = account ? findAccountModel(ctx.modelRegistry, account, preset.model) : undefined;
  // The strategy pick is the best eligible account; when its models don't
  // match the preset's model filter, re-run the strategy among the eligible
  // members that DO have a matching model, so the preset resolves to the best
  // provider/model entry (not just the first rotation-order model match).
  if (!model && preset.model && member) {
    const candidates = eligibleMembers(pool, cfg, rotCtx, state).filter((alt) => {
      const altAccount = cfg.accounts.find((a) => a.credentialId === alt.credentialId);
      return !!altAccount && !!findAccountModel(ctx.modelRegistry, altAccount, preset.model);
    });
    if (candidates.length > 0) {
      const alt = await selectForStrategy(pool, cfg, rotCtx, state, ctx, candidates);
      if (alt) {
        const altAccount = cfg.accounts.find((a) => a.credentialId === alt.credentialId);
        const altModel = altAccount && findAccountModel(ctx.modelRegistry, altAccount, preset.model);
        if (altAccount && altModel) {
          member = alt;
          account = altAccount;
          model = altModel;
        }
      }
    }
  }
  if (!member || !account || !model) {
    notify(
      ctx,
      `Preset "${preset.name}": no eligible member${preset.model ? ` with a model matching "${preset.model}"` : ""} in pool "${pool.name}"`,
      "warning",
    );
    return;
  }
  const switched = await activateAccountModel(pi, ctx.modelRegistry, account, preset.model);
  if (!switched) {
    notify(ctx, `Preset "${preset.name}": could not switch to "${account.label}". Check /login ${member.credentialId}`, "warning");
    return;
  }
  const withPointer: AccountConfig = {
    ...setActiveAccount(global, account.id),
    pools: poolPointerPersists(global, pool.id, pool.credentialIds)
      ? (global.pools ?? []).map((p) => (p.id === pool.id ? { ...p, lastUsedIndex: member!.index } : p))
      : (global.pools ?? []),
  };
  saveGlobalAccountConfig(withPointer);
  notify(ctx, `Preset "${preset.name}": active member is "${account.label}" (${member!.credentialId}, ${model.id})`);
}

async function cmdPresetSetEnabled(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string, enabled: boolean): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const result = setPresetEnabled(cfg, ref, enabled);
  if (!result.ok) {
    notify(ctx, `Preset "${ref}" not found. See: /codex preset list`, "error");
    return;
  }
  saveGlobalAccountConfig(result.cfg);
  const name = resolvePreset(result.cfg, ref)!.name;
  notify(ctx, `Preset "${name}" ${enabled ? "enabled" : "disabled"}`);
}

async function cmdPresetDelete(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const preset = resolvePreset(cfg, ref);
  if (!preset) {
    notify(ctx, `Preset "${ref}" not found. See: /codex preset list`, "error");
    return;
  }
  saveGlobalAccountConfig(deletePreset(cfg, ref));
  notify(ctx, `Deleted preset "${preset.name}"`);
}

// ── Project commands ─────────────────────────────────────────────────────────

function requireTrustedProject(ctx: ExtensionCommandContext): boolean {
  if (ctx.isProjectTrusted()) return true;
  notify(ctx, "Project config only applies to trusted projects. Trust the project in pi first.", "warning");
  return false;
}

/**
 * Apply an enable/disable/clear op to a project override record, returning
 * undefined when no overrides remain (the key is dropped from the file).
 */
function toggleProjectOverride<T>(
  overrides: Record<string, T> | undefined,
  op: "clear" | "enable" | "disable",
  name: string,
): Record<string, T> | undefined {
  const next = { ...(overrides ?? {}) };
  if (op === "clear") delete next[name];
  else next[name] = { ...(next[name] ?? {}), enabled: op === "enable" } as T;
  return Object.keys(next).length > 0 ? next : undefined;
}

function warnUnknownOverrideTarget(ctx: ExtensionCommandContext, kind: string, name: string): void {
  notify(
    ctx,
    `No global ${kind} named "${name}" — this project override will apply once it exists`,
    "warning",
  );
}

async function cmdProjectAllow(ctx: ExtensionCommandContext, rest: string): Promise<void> {
  if (!requireTrustedProject(ctx)) return;
  const cfg = loadGlobalAccountConfig();
  const project = loadProjectAccountConfig(ctx.cwd) ?? {};
  const refs = tokenize(rest);
  if (refs.length === 0) {
    notify(ctx, "Usage: /codex project allow <account...>  |  /codex project allow all", "error");
    return;
  }
  if (refs.some((r) => r === "all")) {
    saveProjectAccountConfig(ctx.cwd, { ...project, allowedCredentialIds: undefined });
    notify(ctx, "Project account restriction cleared — all accounts allowed");
    return;
  }
  const resolved = refs.map((r) => resolveAccount(cfg, r));
  const unknown = resolved.filter((a) => !a).length;
  if (unknown > 0) {
    notify(ctx, "Could not set restriction: unknown account refs", "error");
    return;
  }
  const ids = [...new Set([...(project.allowedCredentialIds ?? []), ...resolved.map((a) => a!.credentialId)])];
  saveProjectAccountConfig(ctx.cwd, { ...project, allowedCredentialIds: ids });
  notify(ctx, `Project restricted to: ${ids.join(", ")}`);
}

async function cmdProjectPool(ctx: ExtensionCommandContext, rest: string): Promise<void> {
  if (!requireTrustedProject(ctx)) return;
  const cfg = loadGlobalAccountConfig();
  const project = loadProjectAccountConfig(ctx.cwd) ?? {};
  const [first, ...rest2] = tokenize(rest);
  if (!first) {
    notify(ctx, "Usage: /codex project pool <name> <member...> | pool enable|disable|clear <name>", "error");
    return;
  }
  if (first === "clear" || first === "enable" || first === "disable") {
    const target = rest2[0];
    if (!target) {
      notify(ctx, "Usage: /codex project pool enable|disable|clear <name>", "error");
      return;
    }
    const overrides = toggleProjectOverride(project.poolOverrides, first, target);
    saveProjectAccountConfig(ctx.cwd, { ...project, poolOverrides: overrides });
    notify(ctx, first === "clear"
      ? `Cleared project pool override for "${target}"`
      : `Project pool "${target}" ${first === "enable" ? "enabled" : "disabled"}`);
    return;
  }
  const name = first;
  const refs = rest2;
  if (refs.length === 0) {
    notify(ctx, "Usage: /codex project pool <name> <member...>", "error");
    return;
  }
  const resolved = refs.map((r) => resolveAccount(cfg, r));
  if (resolved.some((a) => !a)) {
    notify(ctx, "Could not set override: unknown account refs", "error");
    return;
  }
  if (!resolvePool(cfg, name)) warnUnknownOverrideTarget(ctx, "pool", name);
  const ids = [...new Set(resolved.map((a) => a!.credentialId))];
  saveProjectAccountConfig(ctx.cwd, {
    ...project,
    poolOverrides: { ...(project.poolOverrides ?? {}), [name]: { credentialIds: ids } },
  });
  notify(ctx, `Project pool override "${name}": members ${ids.join(", ")}`);
}

async function cmdProjectChain(ctx: ExtensionCommandContext, rest: string): Promise<void> {
  if (!requireTrustedProject(ctx)) return;
  const cfg = loadGlobalAccountConfig();
  const project = loadProjectAccountConfig(ctx.cwd) ?? {};
  const [first, ...rest2] = tokenize(rest);
  if (!first) {
    notify(ctx, "Usage: /codex project chain <name> <target...> | chain enable|disable|clear <name>", "error");
    return;
  }
  if (first === "clear" || first === "enable" || first === "disable") {
    const target = rest2[0];
    if (!target) {
      notify(ctx, "Usage: /codex project chain enable|disable|clear <name>", "error");
      return;
    }
    const overrides = toggleProjectOverride(project.chainOverrides, first, target);
    saveProjectAccountConfig(ctx.cwd, { ...project, chainOverrides: overrides });
    notify(ctx, first === "clear"
      ? `Cleared project chain override for "${target}"`
      : `Project chain "${target}" ${first === "enable" ? "enabled" : "disabled"}`);
    return;
  }
  const name = first;
  const refs = rest2;
  if (refs.length === 0) {
    notify(ctx, "Usage: /codex project chain <name> <target...>", "error");
    return;
  }
  const targets: ChainTarget[] = [];
  for (const ref of refs) {
    const target = resolveTargetRef(cfg, ref);
    if (!target) {
      notify(ctx, `Could not set override: unknown target "${ref}"`, "error");
      return;
    }
    targets.push(target);
  }
  if (!resolveChain(cfg, name)) warnUnknownOverrideTarget(ctx, "chain", name);
  saveProjectAccountConfig(ctx.cwd, {
    ...project,
    chainOverrides: {
      ...(project.chainOverrides ?? {}),
      [name]: { targets },
    },
  });
  notify(ctx, `Project chain override "${name}": ${refs.join(" -> ")}`);
}

async function cmdProjectShow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const global = loadGlobalAccountConfig();
  const project = loadProjectAccountConfig(ctx.cwd);
  const trusted = ctx.isProjectTrusted();
  const effective = trusted && project ? resolveEffectiveConfig(global, project) : global;
  const lines: string[] = [
    `Project: ${ctx.cwd}`,
    `  trusted:   ${trusted ? "yes" : "no"}`,
    `  restriction: ${project?.allowedCredentialIds?.length
      ? project.allowedCredentialIds.join(", ")
      : "none (all accounts allowed)"}`,
  ];
  if (project?.poolOverrides) {
    lines.push("  pool overrides:");
    for (const [name, o] of Object.entries(project.poolOverrides)) {
      lines.push(`    ${name}: ${o.enabled === false ? "disabled" : "enabled"}${o.credentialIds ? `, members ${o.credentialIds.join(", ")}` : ""}`);
    }
  }
  if (project?.chainOverrides) {
    lines.push("  chain overrides:");
    for (const [name, o] of Object.entries(project.chainOverrides)) {
      const targets = o.targets?.map((t) => t.kind === "pool" ? resolvePoolById(effective, t.poolId)?.name ?? t.poolId : t.credentialId).join(" -> ");
      lines.push(`    ${name}: ${o.enabled === false ? "disabled" : "enabled"}${targets ? `, targets ${targets}` : ""}`);
    }
  }
  lines.push("", "Effective pools:");
  const pools = effective.pools ?? [];
  lines.push(...(pools.length === 0 ? ["  (none)"] : pools.map((p) => `  ${p.enabled ? "●" : "○"} ${p.name}  [${p.credentialIds.map((id) => poolMemberLabel(effective, id)).join(", ")}]`)));
  lines.push("", "Effective chains:");
  const chains = effective.chains ?? [];
  lines.push(...(chains.length === 0 ? ["  (none)"] : chains.map((c) => `  ${c.enabled ? "●" : "○"} ${c.name}  [${c.targets.map((t) => targetLabel(effective, t)).join(" -> ")}]`)));
  sendOutput(pi, lines);
}

// ── Argument completions ─────────────────────────────────────────────────────

/** Ref kind completed for the first positional argument after `<section> <sub>`. */
type RefKind = "account" | "pool" | "chain" | "preset";

interface SubSpec {
  name: string;
  desc: string;
  ref?: RefKind;
}

/** Static command tree backing the `/codex ` autocomplete dropdown. */
const SECTION_SPECS: Array<{ name: string; desc: string; subs: SubSpec[] }> = [
  {
    name: "account", desc: "manage Codex accounts", subs: [
      { name: "add", desc: "create a new Codex account" },
      { name: "login", desc: "authenticate the account", ref: "account" },
      { name: "logout", desc: "remove the stored credential", ref: "account" },
      { name: "remove", desc: "remove the account configuration entry", ref: "account" },
      { name: "switch", desc: "switch the active model to the account", ref: "account" },
      { name: "list", desc: "list accounts with auth status" },
      { name: "status", desc: "detailed status for one account", ref: "account" },
      { name: "quota", desc: "inspect quota windows per account", ref: "account" },
      { name: "migrate", desc: "run legacy multi-pass config migration" },
    ],
  },
  {
    name: "pool", desc: "manage account pools", subs: [
      { name: "create", desc: "create a pool from account refs" },
      { name: "list", desc: "list pools with members" },
      { name: "inspect", desc: "per-member eligibility", ref: "pool" },
      { name: "enable", desc: "re-enable a pool", ref: "pool" },
      { name: "disable", desc: "disable a pool (no rotation/failover)", ref: "pool" },
      { name: "delete", desc: "remove the pool", ref: "pool" },
      { name: "add", desc: "add members", ref: "pool" },
      { name: "remove", desc: "remove members", ref: "pool" },
      { name: "use", desc: "select a member by strategy", ref: "pool" },
      { name: "strategy", desc: "set round-robin|quota-first|scheduled|custom", ref: "pool" },
      { name: "schedule", desc: "set time/day windows", ref: "pool" },
      { name: "selector", desc: "custom member selector", ref: "pool" },
    ],
  },
  {
    name: "chain", desc: "manage fallback chains", subs: [
      { name: "create", desc: "create an ordered fallback chain" },
      { name: "list", desc: "list chains with targets" },
      { name: "inspect", desc: "per-target eligibility", ref: "chain" },
      { name: "use", desc: "walk targets and activate", ref: "chain" },
      { name: "enable", desc: "re-enable a chain", ref: "chain" },
      { name: "disable", desc: "disable a chain", ref: "chain" },
      { name: "delete", desc: "remove the chain", ref: "chain" },
      { name: "add", desc: "append targets", ref: "chain" },
      { name: "remove", desc: "remove targets", ref: "chain" },
    ],
  },
  {
    name: "preset", desc: "manage routing presets", subs: [
      { name: "create", desc: "create a named routing preset" },
      { name: "list", desc: "list presets" },
      { name: "inspect", desc: "inspect a preset", ref: "preset" },
      { name: "activate", desc: "resolve best eligible member and switch", ref: "preset" },
      { name: "enable", desc: "re-enable a preset", ref: "preset" },
      { name: "disable", desc: "disable a preset", ref: "preset" },
      { name: "delete", desc: "delete a preset", ref: "preset" },
    ],
  },
  {
    name: "project", desc: "trusted-project overrides", subs: [
      { name: "allow", desc: "restrict project to accounts (or 'all')", ref: "account" },
      { name: "pool", desc: "override a pool for this project", ref: "pool" },
      { name: "chain", desc: "override a chain for this project", ref: "chain" },
      { name: "show", desc: "effective (global + project) config" },
    ],
  },
];

/** Existing refs of a kind, from the loaded account config. */
function refCompletions(kind: RefKind): string[] {
  const cfg = loadGlobalAccountConfig();
  switch (kind) {
    case "account": return cfg.accounts.map((a) => a.label);
    case "pool": return listPools(cfg).map((p) => p.name);
    case "chain": return (cfg.chains ?? []).map((c) => c.name);
    case "preset": return (cfg.presets ?? []).map((p) => p.name);
  }
}

function startsWithFold(value: string, prefix: string): boolean {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * Autocomplete items for the `/codex ` argument: sections, subcommands, then
 * the first positional ref (account labels, pool/chain/preset names). The
 * editor passes the whole text after `/codex `, so items carry the full
 * replacement (`account switch`) — selecting one keeps the section typed so
 * far. Returns null when nothing matches (the dropdown stays hidden).
 */
export function codexArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const trailingSpace = /\s$/.test(argumentPrefix);
  const tokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);

  // Completing the section: "/codex " or "/codex acc".
  if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
    const sectionPrefix = tokens[0] ?? "";
    const items = SECTION_SPECS
      .filter((s) => startsWithFold(s.name, sectionPrefix))
      .map((s) => ({ value: s.name, label: s.name, description: s.desc }));
    return items.length > 0 ? items : null;
  }
  const section = tokens[0].toLowerCase();
  const spec = SECTION_SPECS.find((s) => s.name === section);
  if (!spec) return null;

  // Completing the subcommand: "/codex account" (trailing space) or "/codex account sw".
  if (tokens.length === 1 || (tokens.length === 2 && !trailingSpace)) {
    const subPrefix = tokens.length === 1 ? "" : tokens[1];
    const items = spec.subs
      .filter((sub) => startsWithFold(sub.name, subPrefix))
      .map((sub) => ({ value: `${section} ${sub.name}`, label: `${section} ${sub.name}`, description: sub.desc }));
    return items.length > 0 ? items : null;
  }

  // Completing the first positional ref: "/codex pool use" (trailing space) or "/codex pool use prod".
  const sub = tokens[1].toLowerCase();
  const subSpec = spec.subs.find((s) => s.name === sub);
  if (!subSpec?.ref) return null;
  const refPrefix = tokens.slice(2).join(" ");
  const items = refCompletions(subSpec.ref)
    .filter((ref) => startsWithFold(ref, refPrefix))
    .map((ref) => ({ value: `${section} ${sub} ${ref}`, label: `${section} ${sub} ${ref}`, description: subSpec.desc }));
  return items.length > 0 ? items : null;
}

// ── Command registration ─────────────────────────────────────────────────────

function tokenize(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

export function registerCodexCommand(pi: ExtensionAPI): void {
  pi.registerCommand("codex", {
    description: "Manage Codex accounts and pools (add, authenticate, switch, rotate, failover)",
    getArgumentCompletions: (prefix: string) => codexArgumentCompletions(prefix),
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
          case "quota":  await cmdAccountQuota(pi, ctx, ref); break;
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
          case "use":      await cmdPoolUse(pi, ctx, restArgs.trim()); break;
          case "strategy": await cmdPoolStrategy(pi, ctx, restArgs); break;
          case "schedule": await cmdPoolSchedule(pi, ctx, restArgs); break;
          case "selector": await cmdPoolSelector(pi, ctx, restArgs); break;
          default:
            notify(ctx, USAGE, "info");
        }
        return;
      }
      if (section === "chain") {
        const restArgs = rest.join(" ");
        switch (sub) {
          case "create":  await cmdChainCreate(pi, ctx, restArgs); break;
          case "list":    await cmdChainList(pi, ctx); break;
          case "inspect": await cmdChainInspect(pi, ctx, restArgs.trim()); break;
          case "use":     await cmdChainUse(pi, ctx, restArgs.trim()); break;
          case "enable":  await cmdChainSetEnabled(pi, ctx, restArgs.trim(), true); break;
          case "disable": await cmdChainSetEnabled(pi, ctx, restArgs.trim(), false); break;
          case "delete":  await cmdChainDelete(pi, ctx, restArgs.trim()); break;
          case "add":     await cmdChainAdd(pi, ctx, restArgs); break;
          case "remove":  await cmdChainRemove(pi, ctx, restArgs); break;
          default:
            notify(ctx, USAGE, "info");
        }
        return;
      }
      if (section === "preset") {
        const restArgs = rest.join(" ");
        switch (sub) {
          case "create":   await cmdPresetCreate(pi, ctx, restArgs); break;
          case "list":     await cmdPresetList(pi, ctx); break;
          case "inspect":  await cmdPresetInspect(pi, ctx, restArgs.trim()); break;
          case "activate": await cmdPresetActivate(pi, ctx, restArgs.trim()); break;
          case "enable":   await cmdPresetSetEnabled(pi, ctx, restArgs.trim(), true); break;
          case "disable":  await cmdPresetSetEnabled(pi, ctx, restArgs.trim(), false); break;
          case "delete":   await cmdPresetDelete(pi, ctx, restArgs.trim()); break;
          default:
            notify(ctx, USAGE, "info");
        }
        return;
      }
      if (section === "project") {
        const restArgs = rest.join(" ");
        switch (sub) {
          case "allow":  await cmdProjectAllow(ctx, restArgs); break;
          case "pool":   await cmdProjectPool(ctx, restArgs); break;
          case "chain":  await cmdProjectChain(ctx, restArgs); break;
          case "show":   await cmdProjectShow(pi, ctx); break;
          default:
            notify(ctx, USAGE, "info");
        }
        return;
      }
      notify(ctx, USAGE, "info");
    },
  });
}
