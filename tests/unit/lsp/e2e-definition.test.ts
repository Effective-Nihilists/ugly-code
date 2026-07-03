// Task 7 — end-to-end go-to-definition against a REAL typescript-language-server.
//
// The vitest UglyNative mock can't host an interactive stdio server, so this
// file swaps in the real node host (`createNodeUglyNative` — real fs + real
// child_process streaming) for the duration. The LspClient then drives an
// actual language server over the exact production code path.
//
// The server is spawned via `binaryPath` (the bundled node_modules/.bin binary)
// rather than npx: the fixture lives in os.tmpdir() with no node_modules, so
// `npx --yes` there would network-download. npx resolution itself is covered by
// resolve.test.ts; this test is about the real client↔server interaction.
//
// Skips clearly (never silently) if the server binary isn't installed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNodeUglyNative } from 'ugly-app/native';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LspClient, fileUriToPath } from '../../../client/studio/agent/lsp/client';

const BIN = path.resolve(
  process.cwd(),
  'node_modules/.bin/typescript-language-server',
);
const available = fs.existsSync(BIN);
if (!available) {
  console.warn(
    `[lsp e2e] ${BIN} not found — skipping the real-server go-to-definition test`,
  );
}

const suite = available ? describe : describe.skip;

suite('LSP e2e (real typescript-language-server)', () => {
  const fixtureDir = path.join(os.tmpdir(), `ugly-lsp-e2e-${process.pid}`);
  const bPath = path.join(fixtureDir, 'b.ts');
  let savedNative: unknown;
  let client: LspClient | null = null;

  beforeAll(() => {
    savedNative = (globalThis as { UglyNative?: unknown }).UglyNative;
    (globalThis as { UglyNative?: unknown }).UglyNative = createNodeUglyNative();

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
      'export function foo(): number {\n  return 42;\n}\n',
    );
    fs.writeFileSync(
      bPath,
      "import { foo } from './a';\n\nexport function useFoo(): number {\n  return foo();\n}\n",
    );
  });

  afterAll(async () => {
    if (client) await client.shutdown().catch(() => undefined);
    (globalThis as { UglyNative?: unknown }).UglyNative = savedNative;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it(
    'resolves a cross-file definition (b.ts `foo()` → a.ts export)',
    async () => {
      client = new LspClient({
        workspaceRoot: fixtureDir,
        language: 'typescript',
        binaryPath: BIN,
      });
      await client.start();
      expect(client.getState()).toBe('ready');

      // The whole project graph must be loaded for cross-file resolution.
      await client.ensureProjectLoaded();
      await client.openFile(bPath);

      // `  return foo();` — 0-indexed line 3, `foo` identifier at character 9.
      const defs = await client.findDefinition(bPath, 3, 9);
      const paths = defs.map((d) => fileUriToPath(d.uri));

      expect(defs.length).toBeGreaterThan(0);
      expect(paths.some((p) => p.endsWith('a.ts'))).toBe(true);
    },
    60_000,
  );
});
