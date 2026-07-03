// `python_exec` — run a Python snippet in the project environment. Ported from
// ugly-studio f5a74c2^:server/coding-agent/tools/python-exec.ts.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';
import { spawnCollect } from './spawn';

const SPEC: TextGenTool = {
  name: 'python_exec',
  description:
    'Run a Python snippet (python -c) in the project environment and return its ' +
    'stdout/stderr. Use for quick computation, data inspection, or scripting — ' +
    'not for long-running processes.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python source to execute.' },
    },
    required: ['code'],
    additionalProperties: false,
  },
};

export const pythonExecTool: ToolModule = {
  name: 'python_exec',
  spec: SPEC,
  async run(input, ctx) {
    const code = String(input.code ?? '');
    if (!code) return 'python_exec: `code` is required';
    const root = projectRoot(ctx) ?? undefined;
    const { stdout, stderr, code: exit } = await spawnCollect('python', ['-c', code], {
      ...(root ? { cwd: root } : {}),
    });
    const parts = [stdout.trimEnd()];
    if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
    const out = parts.filter(Boolean).join('\n');
    if (exit !== 0 && exit !== null) return `${out}\n[exit ${exit}]`.trim();
    return out || '(no output)';
  },
};
