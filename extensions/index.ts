import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import bannerExtension from "./banner/index.ts";
import footerExtension from "./footer/index.ts";
import toolsOneLineExtension from "./tools-one-line/index.ts";
import assistantStyleExtension from "./assistant-style/index.ts";
import userStyleExtension from "./user-style/index.ts";
import settingsExtension from "./settings/index.ts";

export default function (pi: ExtensionAPI) {
  settingsExtension(pi);         // register /beautiful-pi first
  bannerExtension(pi);
  footerExtension(pi);
  toolsOneLineExtension(pi);
  assistantStyleExtension(pi);
  userStyleExtension(pi);
}
