// `download` — download a URL into the workspace. Runs a small Node fetch script
// (node is allowlisted; server-side fetch avoids browser CORS). Ported from
// ugly-studio f5a74c2^:server/coding-agent/tools/download.ts.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { resolvePath } from '../tools';
import { projectRoot } from './lspForProject';
import { spawnCollect } from './spawn';

const SPEC: TextGenTool = {
  name: 'download',
  description: 'Download an http/https URL and save it to a file in the workspace.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http/https URL to download.' },
      path: { type: 'string', description: 'Destination file path (workspace-relative).' },
    },
    required: ['url', 'path'],
    additionalProperties: false,
  },
};

export const downloadTool: ToolModule = {
  name: 'download',
  spec: SPEC,
  async run(input, ctx) {
    const url = String(input.url ?? '');
    const path = String(input.path ?? '');
    if (!/^https?:\/\//i.test(url)) return `download: only http/https URLs are supported (got ${url})`;
    if (!path) return 'download: `path` is required';
    const abs = resolvePath(ctx, path);
    const script =
      `(async()=>{const r=await fetch(${JSON.stringify(url)});` +
      `if(!r.ok){console.error('HTTP '+r.status);process.exit(1)}` +
      `const b=Buffer.from(await r.arrayBuffer());` +
      `require('fs').writeFileSync(${JSON.stringify(abs)},b);` +
      `console.log('downloaded '+b.length+' bytes to '+${JSON.stringify(path)})})()` +
      `.catch(e=>{console.error(e&&e.message||e);process.exit(1)})`;
    const root = projectRoot(ctx) ?? undefined;
    const { stdout, stderr, code } = await spawnCollect('node', ['-e', script], {
      ...(root ? { cwd: root } : {}),
    });
    if (code !== 0 && code !== null) return `download failed: ${(stderr || stdout).trim()}`;
    return stdout.trim() || 'downloaded';
  },
};
