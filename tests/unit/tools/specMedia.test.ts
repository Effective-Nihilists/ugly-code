// Phase B6.4-6 — spec_read, analyze_image, inspect_ux.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('ugly-app/native', () => ({
  native: {
    uglybot: { request: vi.fn() },
    fs: { readFileBytes: vi.fn(async () => new Uint8Array([1, 2, 3])) },
  },
}));

import { specReadTool } from '../../../client/agent/tools/specRead';
import { analyzeImageTool } from '../../../client/agent/tools/analyzeImage';
import { inspectUxTool } from '../../../client/agent/tools/inspectUx';
import { native } from 'ugly-app/native';

const req = vi.mocked(
  (native as unknown as { uglybot: { request: ReturnType<typeof vi.fn> } })
    .uglybot.request,
);
beforeEach(() => req.mockReset());

describe('spec_read', () => {
  it('lists specs when no id', async () => {
    req.mockResolvedValue({ specs: [{ id: 's1', title: 'Auth' }] });
    const out = await specReadTool.run({}, undefined);
    expect(out).toContain('s1');
    expect(out).toContain('Auth');
  });
  it('degrades cleanly when the service reports an error', async () => {
    req.mockResolvedValue({ error: 'no spec service' });
    expect(await specReadTool.run({ id: 'x' }, undefined)).toMatch(
      /unavailable/i,
    );
  });
});

describe('analyze_image', () => {
  it('sends a url to the vision model and returns text', async () => {
    req.mockResolvedValue({ text: 'A red button.' });
    const out = await analyzeImageTool.run(
      { url: 'https://ex.com/i.png', prompt: 'what?' },
      undefined,
    );
    expect(out).toContain('A red button');
    expect(req).toHaveBeenCalledWith('textGen', expect.anything());
  });
  it('requires a path or url', async () => {
    expect(await analyzeImageTool.run({}, undefined)).toMatch(
      /path.*url|url.*path/i,
    );
  });
});

describe('inspect_ux', () => {
  afterEach(() => {
    delete (globalThis as { __uglyInspect?: unknown }).__uglyInspect;
  });
  it('runs __uglyInspect when present', async () => {
    (globalThis as { __uglyInspect?: unknown }).__uglyInspect = async () => ({
      cls: { total: 0.02 },
    });
    const out = await inspectUxTool.run({ url_path: '/x' }, undefined);
    expect(out).toContain('cls');
  });
  it('degrades when the inspect surface is absent', async () => {
    const out = await inspectUxTool.run({}, undefined);
    expect(out).toMatch(/unavailable/i);
  });
});
