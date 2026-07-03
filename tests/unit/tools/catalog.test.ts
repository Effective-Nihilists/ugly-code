// Static tool gating (gating.ts) + the tool_search / tool_request utility tools.
// Replaces the earlier dynamic-catalog tests — tool availability is now decided
// statically per mode / project / feature (the monolith's model).
import { describe, it, expect } from 'vitest';
import { allowedToolNames, sessionToolSpecs } from '../../../client/agent/tools/gating';
import { toolSearchTool } from '../../../client/agent/tools/toolSearch';
import { toolRequestTool } from '../../../client/agent/tools/toolRequest';

describe('static tool gating', () => {
  it('single mode exposes COMMON + single-mode tools', () => {
    const s = allowedToolNames({ mode: 'single', isUglyApp: false });
    expect(s.has('read')).toBe(true); // COMMON
    expect(s.has('grep')).toBe(true);
    expect(s.has('bash')).toBe(true);
    expect(s.has('web_search')).toBe(true); // single-mode
    expect(s.has('tool_search')).toBe(true);
    expect(s.has('blackboard_post')).toBe(false); // group-only
    expect(s.has('database')).toBe(false); // ugly-app only
  });

  it('group mode swaps the single-mode set for blackboard_post', () => {
    const s = allowedToolNames({ mode: 'group', isUglyApp: false });
    expect(s.has('read')).toBe(true); // COMMON still present
    expect(s.has('blackboard_post')).toBe(true);
    expect(s.has('web_search')).toBe(false); // single-mode only
    expect(s.has('scratchpad')).toBe(false);
  });

  it('an ugly-app project adds the UGLY_APP tools', () => {
    const off = allowedToolNames({ mode: 'single', isUglyApp: false });
    const on = allowedToolNames({ mode: 'single', isUglyApp: true });
    expect(off.has('database')).toBe(false);
    expect(off.has('inspect_ux')).toBe(false);
    expect(on.has('database')).toBe(true);
    expect(on.has('database_sql_query')).toBe(true);
    expect(on.has('inspect_ux')).toBe(true);
    expect(on.has('dev_server_start')).toBe(true);
  });

  it('feature gates: multiAgent defaults OFF (no delegate); memory/specs toggle', () => {
    const def = allowedToolNames({ mode: 'single', isUglyApp: false });
    expect(def.has('delegate')).toBe(false); // multiAgent off by default
    expect(def.has('memory_read')).toBe(true);
    expect(def.has('spec_write')).toBe(true);

    const on = allowedToolNames({ mode: 'single', isUglyApp: false, features: { multiAgent: true } });
    expect(on.has('delegate')).toBe(true);
    expect(on.has('delegate_parallel')).toBe(true);

    const noMem = allowedToolNames({ mode: 'single', isUglyApp: false, features: { memoryRead: false, memoryWrite: false } });
    expect(noMem.has('memory_read')).toBe(false);
    expect(noMem.has('memory_save')).toBe(false);
  });

  it('sessionToolSpecs returns only specs for allowed, defined tools', () => {
    const specs = sessionToolSpecs({ mode: 'single', isUglyApp: false });
    const names = specs.map((t) => t.name);
    expect(names).toContain('read');
    expect(names).toContain('grep');
    expect(names).not.toContain('blackboard_post');
    // dev_server_start is allowed only for ugly-app projects, and has no defined
    // tool yet — so it must never leak into the specs here.
    expect(names).not.toContain('dev_server_start');
  });
});

describe('tool_request / tool_search utilities', () => {
  it('tool_request explains why an existing tool is out of scope', async () => {
    const out = await toolRequestTool.run({ name: 'blackboard_post' }, undefined);
    expect(out).toMatch(/gated/i);
  });

  it('tool_request reports a truly unknown tool', async () => {
    expect(await toolRequestTool.run({ name: 'does_not_exist' }, undefined)).toMatch(/no such tool/i);
  });

  it('tool_search ranks the catalog by intent', async () => {
    const out = await toolSearchTool.run({ query: 'download a file from a url' }, undefined);
    expect(out).toContain('download');
  });
});
