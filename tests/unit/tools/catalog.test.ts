// Phase B6.1-3 — dynamic tool catalog + tool_search + tool_request.
import { describe, it, expect } from 'vitest';
import { activeToolSpecs } from '../../../client/agent/tools/catalog';
import { toolSearchTool } from '../../../client/agent/tools/toolSearch';
import { toolRequestTool } from '../../../client/agent/tools/toolRequest';

describe('dynamic tool catalog', () => {
  it('a fresh session starts with the core tools only', () => {
    const names = activeToolSpecs('cat-1').map((t) => t.name);
    expect(names).toContain('grep');
    expect(names).toContain('read_file');
    expect(names).toContain('tool_search');
    expect(names).not.toContain('web_search'); // non-core, request on demand
  });

  it('tool_request activates a non-core tool for the session', async () => {
    const out = await toolRequestTool.run({ name: 'web_search' }, { sessionId: 'cat-2' });
    expect(out).toMatch(/activated/i);
    expect(activeToolSpecs('cat-2').map((t) => t.name)).toContain('web_search');
    // other sessions are unaffected
    expect(activeToolSpecs('cat-3').map((t) => t.name)).not.toContain('web_search');
  });

  it('tool_request rejects unknown tools', async () => {
    expect(await toolRequestTool.run({ name: 'does_not_exist' }, { sessionId: 'cat-4' })).toMatch(/no tool/i);
  });

  it('tool_search ranks the catalog by intent', async () => {
    const out = await toolSearchTool.run({ query: 'download a file from a url' }, undefined);
    expect(out).toContain('download');
  });
});
