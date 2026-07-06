import { describe, it, expect } from 'vitest';
import { truncateOutput } from '../../../client/agent/tools/outputTruncate';

describe('truncateOutput', () => {
  it('passes short output through unchanged', () => {
    expect(truncateOutput('a\nb\nc')).toBe('a\nb\nc');
  });
  it('collapses long output to head + tail with an elision marker', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line${i}`).join('\n');
    const out = truncateOutput(text);
    expect(out).toContain('line0');
    expect(out).toContain('line299');
    expect(out).toMatch(/truncated \d+ lines, showing first 100 and last 50/);
    expect(out).not.toContain('line150');
  });
});
