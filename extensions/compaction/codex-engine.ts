import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const name = "@ogulcancelik/pi-codex-compaction";
const expected = require("../../package.json").dependencies[name] as string;
const installed = require("@ogulcancelik/pi-codex-compaction/package.json").version as string;
if (installed !== expected) {
  throw new Error(`Compaction dependency version mismatch: ${name} installed ${installed}, expected ${expected}. Reinstall beautiful-pi dependencies.`);
}

// Pi's extension loader handles the upstream TypeScript entry point at runtime.
const { default: codexCompaction } = require("@ogulcancelik/pi-codex-compaction/index.ts") as {
  default: (pi: ExtensionAPI) => void;
};

export default codexCompaction;
