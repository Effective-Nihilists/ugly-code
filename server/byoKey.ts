// Server-side resolution of the user's own provider key for BYO-subscription
// models (currently only `glm_coding_plan`, backed by a Z.ai GLM Coding Plan).
//
// Shared by BOTH server entries — the Node one (server/index.ts) and the
// Cloudflare Worker (server/workers.ts, which is what code.ugly.bot actually
// serves) — so the deployed app and local dev behave identically. They differ
// only in how they reach the settings doc, hence the injected `getDoc`.
//
// The key never travels to the browser: `agentTurnHandler` calls this on the
// server, per turn, and only for a model that needs it.
import { isByoKeyTextGenModel } from 'ugly-app/shared';
import { collections } from '../shared/collections';
import { parseStoredUserSettings } from '../shared/userSettings';

/** The narrow slice of TypedDB this needs; satisfied by Node and Workers alike. */
export interface SettingsDocReader {
  getDoc(
    collection: typeof collections.userSettings,
    id: string,
  ): Promise<{ data?: string | null } | null | undefined>;
}

/**
 * Build the `resolveApiKey` hook for `agentTurnHandler`.
 *
 * Returns undefined for ordinary metered models WITHOUT touching Neon — a
 * normal turn must not pay for a settings read. For a BYO model with no key
 * stored we also return undefined and let ugly.bot refuse the call; it will
 * never fall back to the shared provider account.
 */
export function makeResolveApiKey(
  db: () => SettingsDocReader,
): (userId: string, model: string) => Promise<string | undefined> {
  return async (userId, model) => {
    if (!isByoKeyTextGenModel(model)) return undefined;
    try {
      const doc = await db().getDoc(collections.userSettings, userId);
      return parseStoredUserSettings(doc?.data).codingAgent.glmCodingKey;
    } catch {
      // A settings read failure must not take the turn down with an opaque
      // error; ugly.bot returns a clear "needs your own key" refusal instead.
      return undefined;
    }
  };
}
