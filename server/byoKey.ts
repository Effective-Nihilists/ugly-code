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

/** How many times to attempt the (BYO-only) settings read before giving up. */
const READ_ATTEMPTS = 3;

/**
 * Build the `resolveApiKey` hook for `agentTurnHandler`.
 *
 * Returns undefined for ordinary metered models WITHOUT touching the DB — a
 * normal turn must not pay for a settings read (and so is never exposed to a
 * read failure). For a BYO model:
 *   • read OK, key present  → return the key
 *   • read OK, no key stored → return undefined (ugly.bot refuses with a clear
 *     "add your key" message; it never falls back to the shared account)
 *   • read FAILS             → retry, then THROW an honest, distinct error.
 *
 * The throw is the whole point of this file's last incident: a *transient* read
 * failure (a D1 blip, or a request whose per-request TypedDB wasn't set) used to
 * be swallowed to `undefined`, which is indistinguishable from "no key stored".
 * The turn then went to ugly.bot keyless and got refused with
 * "glm_coding_plan requires the caller to supply their own Z.ai Coding Plan key"
 * — telling the user to add a key they already added, and only on random turns.
 * A thrown error propagates through `streamAgentTurn` and surfaces the REAL
 * reason instead. Metered turns never read, so they can never throw here.
 */
export function makeResolveApiKey(
  db: () => SettingsDocReader,
): (userId: string, model: string) => Promise<string | undefined> {
  return async (userId, model) => {
    if (!isByoKeyTextGenModel(model)) return undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      try {
        const doc = await db().getDoc(collections.userSettings, userId);
        // A successful read with no key is a genuine "add your key" — undefined.
        return parseStoredUserSettings(doc?.data).codingAgent.glmCodingKey;
      } catch (e) {
        lastErr = e;
      }
    }
    const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(
      `Couldn't load your saved Z.ai GLM Coding Plan key (transient settings-read failure — please retry). [${detail}]`,
    );
  };
}
