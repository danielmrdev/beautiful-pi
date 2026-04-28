import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import bannerExtension from "./banner.ts";
import footerExtension from "./footer.ts";

export default function (pi: ExtensionAPI) {
  bannerExtension(pi);
  footerExtension(pi);
}
