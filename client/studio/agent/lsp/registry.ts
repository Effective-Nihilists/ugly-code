/**
 * Workspace-scoped LSP client registry for the studio editor.
 *
 * Editor-side LSP requests (go to definition, find references, hover,
 * rename) need a long-lived language server per (workspace, language).
 * The coding agent owns its own LspClient per session for diagnostics
 * tracking; the editor's client is independent so it survives across
 * agent sessions and reflects on-disk content rather than the agent's
 * uncommitted didChange stream.
 */

import path from 'path';
import { LspClient, type LspLanguage } from './client.js';

export type EditorLspLanguage = LspLanguage;

export function languageIdForPath(filePath: string): EditorLspLanguage | null {
  const lower = filePath.toLowerCase();
  if (
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  ) {
    return 'typescript';
  }
  if (lower.endsWith('.py')) return 'python';
  return null;
}

const clients = new Map<string, LspClient>();

function key(workspaceRoot: string, language: EditorLspLanguage): string {
  return `${language}::${path.resolve(workspaceRoot)}`;
}

/**
 * Lazily get-or-create an LSP client for a workspace + language. The
 * caller is responsible for `openFile` before issuing position-based
 * requests. The returned client may be in `disabled` state if no
 * binary was found — methods will return empty results in that case.
 */
export async function getEditorLspClient(
  workspaceRoot: string,
  language: EditorLspLanguage,
): Promise<LspClient> {
  const k = key(workspaceRoot, language);
  let client = clients.get(k);
  if (!client) {
    client = new LspClient({ workspaceRoot, language });
    clients.set(k, client);
  }
  // start() is idempotent; safe to call repeatedly.
  try {
    await client.start();
  } catch {
    // disabled / error states are surfaced as empty results from
    // request methods — don't bubble.
  }
  return client;
}

/**
 * Tear down all editor LSP clients. Called during studio shutdown.
 */
export async function shutdownAllEditorLspClients(): Promise<void> {
  const entries = Array.from(clients.values());
  clients.clear();
  await Promise.all(entries.map((c) => c.shutdown().catch(() => undefined)));
}
