import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const name = "pi-blackhole";
const expected = require("../../package.json").dependencies[name] as string;
const installed = require("pi-blackhole/package.json").version as string;
if (installed !== expected) {
  throw new Error(`Compaction dependency version mismatch: ${name} installed ${installed}, expected ${expected}. Reinstall beautiful-pi dependencies.`);
}

const { default: blackhole } = require("pi-blackhole") as {
  default: (pi: ExtensionAPI) => Promise<void>;
};

export default blackhole;
