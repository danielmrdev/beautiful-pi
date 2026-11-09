/**
 * i18n bridge for rpiv-ask-user-question — single thin import surface so every
 * call site routes through one place. Backed by `@juicesharp/rpiv-i18n`'s SDK
 * when available; degrades to canonical-English fallbacks when not.
 *
 * - `t(key, fallback)` is `scope("@juicesharp/rpiv-ask-user-question")` if the
 *   SDK is installed (live `/languages` updates propagate). If the SDK is
 *   missing (standalone install without rpiv-i18n), `t` is an identity
 *   passthrough that returns the inline English fallback at every call site,
 *   so the extension stays online with English UI.
 * - `displayLabel(kind)` resolves a sentinel kind to its locale-aware label,
 *   with the canonical English `ROW_INTENT_META[kind].label` as fallback so
 *   nothing renders blank if the namespace isn't registered.
 *
 * Strings are registered ONCE at extension load (see ../index.ts). Call sites
 * MUST use this module at render time — never bake the result into a top-level
 * `const X = displayLabel(...)`.
 *
 * Reserved-label validation stays English-locked: `RESERVED_LABEL_SET` checks
 * the canonical `ROW_INTENT_META[kind].label`, never `displayLabel(kind)`.
 */

import { ROW_INTENT_META, type SentinelKind } from "./row-intent.ts";

export const I18N_NAMESPACE = "@juicesharp/rpiv-ask-user-question";

type ScopeFn = (key: string, fallback: string) => string;
type I18nSDK = { scope: (namespace: string) => ScopeFn };

// Prefer the live SDK if installed: closures it returns track the active
// locale, so /languages picker propagates to our render call sites. If the
// SDK isn't installed (standalone install of this extension without
// rpiv-i18n), the dynamic import fails, every t(key, fallback) returns the
// canonical English literal, and the extension stays online.
//
// Top-level await is required so a synchronous `t(...)` call from any
// downstream module sees the resolved scope; ESM module loading awaits this
// before evaluating any importer.
let scopeImpl: ScopeFn = (_key, fallback) => fallback;

// Resolve the SDK asynchronously so this module stays loadable in CJS runtimes
// (no top-level await). Until the promise settles, `t` returns the English
// fallback; once resolved, subsequent renders use the live scope.
const moduleName = "@juicesharp/rpiv-i18n";
import(moduleName)
	.then((sdk: I18nSDK) => {
		try {
			scopeImpl = sdk.scope(I18N_NAMESPACE);
		} catch {
			// keep fallback
		}
	})
	.catch(() => {
		// SDK absent — keep English fallback.
	});

export function t(key: string, fallback: string): string {
	return scopeImpl(key, fallback);
}

export function displayLabel(kind: SentinelKind): string {
	return t(`sentinel.${kind}`, ROW_INTENT_META[kind].label);
}
