/**
 * Shared context helpers: build a RotationContext from an extension context
 * (auth status via modelRegistry, project restriction via cwd). Used by both
 * the pool commands and the failover wiring.
 */
import { isCredentialAllowed } from "./store.ts";
import type { RotationContext } from "./rotation.ts";

export interface AuthAwareContext {
  cwd: string;
  modelRegistry: {
    getProviderAuthStatus(id: string): { configured: boolean } | undefined;
  };
}

export function rotationContextFrom(ctx: AuthAwareContext): RotationContext {
  return {
    authConfigured: (id) => {
      try {
        return ctx.modelRegistry.getProviderAuthStatus(id)?.configured === true;
      } catch {
        return false;
      }
    },
    allowed: (id) => isCredentialAllowed(ctx.cwd, id),
  };
}
