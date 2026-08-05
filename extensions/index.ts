import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bannerExtension from "./banner/index.ts";
import footerExtension from "./footer/index.ts";
import toolsOneLineExtension from "./tools-one-line/index.ts";
import assistantStyleExtension from "./assistant-style/index.ts";
import userStyleExtension from "./user-style/index.ts";
import customMessageExtension from "./custom-message/index.ts";
import settingsExtension from "./settings/index.ts";
import sessionTitleExtension from "./session-title/index.ts";
import herdrPaneSyncExtension from "./herdr-pane-sync/index.ts";
import codexAccountsExtension from "./codex-accounts/index.ts";
import compactionCoordinator from "./compaction/index.ts";

export default function (pi: ExtensionAPI) {
  settingsExtension(pi);         // register /bpi (+ /beautiful-pi alias)
  codexAccountsExtension(pi);    // register /codex account + legacy migration
  compactionCoordinator(pi);     // keep compaction engines provider-aware (#7)
  sessionTitleExtension(pi);
  herdrPaneSyncExtension(pi);
  bannerExtension(pi);
  footerExtension(pi);
  toolsOneLineExtension(pi);
  assistantStyleExtension(pi);
  userStyleExtension(pi);
  customMessageExtension(pi);
}
