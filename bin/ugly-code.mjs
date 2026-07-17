#!/usr/bin/env node
// ugly-code CLI launcher. Runs the TypeScript entry via the bundled tsx so
// `pnpm dlx ugly-code --eval <task>` works without a separate build step.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'client', 'cli', 'index.ts');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const r = spawnSync(tsx, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
