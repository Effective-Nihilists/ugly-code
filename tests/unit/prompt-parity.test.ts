// Phase P — the system prompt is restored from the monolith. Assert the key
// monolith sections are present and every tool the prompt tells the model to use
// exists in the catalog (adapted to ugly-code's tool names).
import { describe, it, expect } from 'vitest';
import { AGENT_SYSTEM_PROMPT, AGENT_TOOL_NAMES } from '../../shared/agent';
import { fullCatalog } from '../../client/agent/tools/catalog';

describe('system prompt parity with the monolith', () => {
  it('carries the monolith critical-rules methodology', () => {
    expect(AGENT_SYSTEM_PROMPT).toMatch(/PLAN BEFORE YOU EXPLORE/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/EDIT BOLDLY/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/critical_rules/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/tool_search/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/tool_request/);
  });

  it('uses ugly-code tool names, not the monolith short names', () => {
    // The monolith said `read`/`bash`; ugly-code says read_file/run_command.
    expect(AGENT_SYSTEM_PROMPT).toMatch(/`read_file`/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/`run_command`/);
    expect(AGENT_SYSTEM_PROMPT).not.toMatch(/`bash`/);
  });

  it('every tool it instructs the model to use exists in the catalog', () => {
    const known = new Set<string>([
      ...AGENT_TOOL_NAMES,
      ...fullCatalog().map((t) => t.name),
    ]);
    // Backticked tokens the prompt uses as tool names (excluding params,
    // status values, and the explicitly-nonexistent apply_patch/apply_diff).
    const NON_TOOLS = new Set([
      'in_progress', 'completed', 'pending', 'reason', 'description',
      'old_string', 'new_string', 'anchor', 'range', 'apply_patch', 'apply_diff',
      'old', 'new', 'content', 'path', 'query', 'cmd', 'args',
    ]);
    const referenced = [...AGENT_SYSTEM_PROMPT.matchAll(/`([a-z_]{3,})`/g)]
      .map((m) => m[1])
      .filter((n) => !NON_TOOLS.has(n));
    const missing = referenced.filter((n) => !known.has(n));
    expect(missing).toEqual([]);
  });
});
