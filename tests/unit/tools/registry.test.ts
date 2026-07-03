// Task 0.1 — the tool registry that dispatchTool consults for restored tools.
import { describe, it, expect } from 'vitest';
import {
  TOOL_REGISTRY,
  runRegisteredTool,
} from '../../../client/agent/tools/registry';

describe('tool registry', () => {
  it('registered tool names are unique', () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('runRegisteredTool returns undefined for an unknown tool', async () => {
    expect(
      await runRegisteredTool('definitely_not_a_tool', {}, undefined),
    ).toBeUndefined();
  });
});
