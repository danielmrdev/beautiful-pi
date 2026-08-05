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
import type { Model } from "@earendil-works/pi-ai";
import {
  loadGlobalAccountConfig,
  saveGlobalAccountConfig,
  addAccount,
  removeAccount,
  setActiveAccount,
  resolveAccount,
  isCredentialAllowed,
  agentDirPath,
  authFilePath,
} from "./store.ts";
import { nextCodexCredentialId, registerAccountProvider, isSuffixedCodexId } from "./provider.ts";
import { getProviderAdapter } from "./registry.ts";
import { runMigration } from "./migration.ts";
import type { AccountConfig, CodexAccount, ProviderAccountAdapter } from "./types.ts";

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

function accountOrError(cfg: AccountConfig, ref: string | undefined): CodexAccount | undefined {
  if (!ref) {
    const active = cfg.activeAccountId
      ? cfg.accounts.find((a) => a.id === cfg.activeAccountId)
      : cfg.accounts.find((a) => a.active);
    return active ?? cfg.accounts[0];
  }
  return resolveAccount(cfg, ref);
}

function adapterFor(account: CodexAccount): ProviderAccountAdapter | undefined {
  return getProviderAdapter(account.provider);
}

function authStatusOf(ctx: ExtensionCommandContext, credentialId: string): { configured: boolean; source?: string; label?: string } {
  try {
    return ctx.modelRegistry.getProviderAuthStatus(credentialId);
  } catch {
    return { configured: false };
  }
}

function formatAccountRow(ctx: ExtensionCommandContext, account: CodexAccount, activeId?: string): string {
  const adapter = adapterFor(account);
  const status = authStatusOf(ctx, account.credentialId);
  const credential = readStoredCredential(account.credentialId, authFilePath());
  const statusLine = adapter?.statusLine(status, credential) ?? (status.configured ? "authenticated" : "not authenticated");
  const active = account.id === activeId || account.active ? "●" : " ";
  return `${active} ${account.label}  [${account.credentialId}]  ${statusLine}`;
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
  const credentialId = nextCodexCredentialId(cfg.accounts.map((a) => a.credentialId));
  const result = addAccount(cfg, {
    provider: "openai-codex",
    credentialId,
    label,
    active: cfg.accounts.length === 0 && !cfg.activeAccountId,
  });
  let next = result.cfg;
  if (result.created && cfg.accounts.length === 0 && !cfg.activeAccountId) {
    next = setActiveAccount(next, result.account.id);
  }
  saveGlobalAccountConfig(next);
  if (result.created) {
    registerAccountProvider(ctx.modelRegistry, result.account);
    notify(ctx, `Added Codex account "${label}" as ${credentialId}. Authenticate with: /login ${credentialId}`);
  } else {
    notify(ctx, `Account "${label}" already exists as ${result.account.credentialId}`);
  }
}

async function cmdLogin(ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = accountOrError(cfg, ref);
  if (!account) {
    notify(ctx, "No Codex accounts yet. Add one with: /codex account add <label>", "warning");
    return;
  }
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
  const account = accountOrError(cfg, ref);
  if (!account) {
    notify(ctx, "No Codex accounts yet. Add one with: /codex account add <label>", "warning");
    return;
  }
  const status = authStatusOf(ctx, account.credentialId);
  if (!status.configured) {
    notify(ctx, `Account "${account.label}" is not authenticated`);
    return;
  }
  notify(ctx, `Remove the stored credential with: /logout ${account.credentialId}`);
}

async function cmdRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, ref: string | undefined): Promise<void> {
  const cfg = loadGlobalAccountConfig();
  const account = accountOrError(cfg, ref);
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
  const account = accountOrError(cfg, ref);
  if (!account) {
    notify(ctx, "No Codex accounts yet. Add one with: /codex account add <label>", "warning");
    return;
  }
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
  const account = accountOrError(cfg, ref);
  if (!account) {
    sendOutput(pi, ["No matching Codex account found."]);
    return;
  }
  const adapter = adapterFor(account);
  const status = authStatusOf(ctx, account.credentialId);
  const credential = readStoredCredential(account.credentialId, authFilePath());
  const allowed = isCredentialAllowed(ctx.cwd, account.credentialId);
  const lines = [
    `Account: ${account.label}`,
    `  credential:  ${account.credentialId}`,
    `  provider:    ${adapter?.displayName ?? account.provider}`,
    `  status:      ${adapter?.statusLine(status, credential) ?? (status.configured ? "authenticated" : "not authenticated")}`,
    `  project:     ${allowed ? "allowed" : "restricted in this project"}`,
    `  created:     ${account.createdAt.slice(0, 10)}`,
    ...(account.lastUsedAt ? [`  last used:   ${account.lastUsedAt.slice(0, 10)}`] : []),
    ...(account.legacy?.index !== undefined ? [`  legacy:      migrated from multi-pass (subscription #${account.legacy.index})`] : account.legacy ? ["  legacy:      migrated from multi-pass"] : []),
    ...(status.configured ? [] : [`  next:        /login ${account.credentialId}`]),
  ];
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

// ── Command registration ─────────────────────────────────────────────────────

function tokenize(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

export function registerCodexCommand(pi: ExtensionAPI): void {
  pi.registerCommand("codex", {
    description: "Manage Codex accounts (add, authenticate, switch, migrate)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [section, sub, ...rest] = tokenize(args);
      if (section !== "account") {
        notify(ctx, USAGE, "info");
        return;
      }
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
    },
  });
}
