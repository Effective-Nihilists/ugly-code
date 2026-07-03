// Per-session dynamic tool catalog. The model starts each session with a CORE
// set of tools; tool_search finds others in the full catalog and tool_request
// activates them into the session's set (kept small to save context). Ported
// from the monolith's tool-search / tool-request / tool-specs machinery.

import type { TextGenTool } from 'ugly-app/shared';
import { AGENT_TOOLS } from '../../../shared/agent';
import { registeredToolSpecs } from './registry';

/** Always-available tools — the essentials for reading/editing/searching. */
export const CORE_TOOLS = new Set<string>([
  'list_dir', 'read_file', 'write_file', 'edit_file', 'multiedit', 'run_command',
  'grep', 'glob', 'codebase_search', 'lsp_diagnostics', 'todos', 'scratchpad',
  'tool_search', 'tool_request',
]);

/** Every tool the agent could use (core + registry). Called lazily so the
 *  registry is fully populated (avoids an import-time cycle). */
export function fullCatalog(): TextGenTool[] {
  return [...AGENT_TOOLS, ...registeredToolSpecs()];
}

const activeBySession = new Map<string, Set<string>>();

function active(sessionId: string): Set<string> {
  let s = activeBySession.get(sessionId);
  if (!s) {
    s = new Set(CORE_TOOLS);
    activeBySession.set(sessionId, s);
  }
  return s;
}

/** Activate a tool into a session's active set. Returns false for unknown names. */
export function activateTool(sessionId: string, name: string): boolean {
  if (!fullCatalog().some((t) => t.name === name)) return false;
  active(sessionId).add(name);
  return true;
}

/** The tool specs currently active for a session (what the model sees). */
export function activeToolSpecs(sessionId: string): TextGenTool[] {
  const a = active(sessionId);
  return fullCatalog().filter((t) => a.has(t.name));
}

/** Rank the full catalog against a natural-language query by word overlap. */
export function searchCatalog(query: string): { name: string; description: string; score: number }[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return fullCatalog()
    .map((t) => {
      const hay = `${t.name} ${t.description}`.toLowerCase();
      const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
      return { name: t.name, description: t.description, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}
