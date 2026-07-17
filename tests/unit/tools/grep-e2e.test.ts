// Task B1.6 — grep lsp-defs end-to-end against a REAL typescript-language-server.
// Swaps the vitest UglyNative mock for the real node host (createNodeUglyNative)
// and drives grepTool → runLspMode → the registry LspClient → a spawned server.
// The fixture lives UNDER ugly-code so `npx typescript-language-server` resolves
// the installed binary offline (npx walks up to ugly-code/node_modules/.bin).
// Skips clearly if the server isn't installed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNodeUglyNative } from 'ugly-app/native';
import fs from 'node:fs';
import path from 'node:path';
import { grepTool } from '../../../client/agent/tools/grep';
import { shutdownAllEditorLspClients } from '../../../client/studio/agent/lsp/registry';

const BIN = path.resolve(
  process.cwd(),
  'node_modules/.bin/typescript-language-server',
);
const available = fs.existsSync(BIN);
if (!available) {
  console.warn(
    '[grep e2e] typescript-language-server not installed — skipping',
  );
}
const suite = available ? describe : describe.skip;

suite('grep lsp-defs e2e (real typescript-language-server)', () => {
  const fixtureDir = path.join(process.cwd(), '.lsp-grep-e2e');
  let saved: unknown;

  beforeAll(() => {
    saved = (globalThis as { UglyNative?: unknown }).UglyNative;
    (globalThis as { UglyNative?: unknown }).UglyNative =
      createNodeUglyNative();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          target: 'es2022',
          noEmit: true,
        },
        include: ['*.ts'],
      }),
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'a.ts'),
      'export function fooBarBaz(): number {\n  return 42;\n}\n',
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'b.ts'),
      "import { fooBarBaz } from './a';\nexport const z = fooBarBaz();\n",
    );
  });

  afterAll(async () => {
    await shutdownAllEditorLspClients().catch(() => undefined);
    (globalThis as { UglyNative?: unknown }).UglyNative = saved;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('grep mode lsp-defs resolves a symbol to its declaration file', async () => {
    const out = await grepTool.run(
      { mode: 'lsp-defs', pattern: 'fooBarBaz' },
      { projectDir: fixtureDir },
    );
    expect(out).toMatch(/a\.ts:1:/);
  }, 60_000);
});
