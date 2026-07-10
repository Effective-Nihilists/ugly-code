// Phase B4 — todos, scratchpad, memory_*, ask_user.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetMock, mockFiles } from '../../helpers/uglyNativeMock';
import { todosTool } from '../../../client/agent/tools/todos';
import { scratchpadTool } from '../../../client/agent/tools/scratchpad';
import { memoryAddTool } from '../../../client/agent/tools/memory';
import { askUserTool } from '../../../client/agent/tools/askUser';

beforeEach(() => resetMock({ files: {} }));

describe('todos', () => {
  it('renders the list with status markers', async () => {
    const out = await todosTool.run(
      {
        todos: [
          { content: 'Plan the work', status: 'completed' },
          { content: 'Write code', status: 'in_progress' },
          { content: 'Test it', status: 'pending' },
        ],
      },
      { sessionId: 's1' },
    );
    expect(out).toMatch(/\[x\].*Plan the work/);
    expect(out).toMatch(/(\[~\]|\[>\]).*Write code/);
    expect(out).toMatch(/\[ \].*Test it/);
  });
});

describe('scratchpad', () => {
  it('append then read returns the notes', async () => {
    await scratchpadTool.run({ action: 'append', content: 'note one' }, { sessionId: 's1', projectDir: '/proj' });
    await scratchpadTool.run({ action: 'append', content: 'note two' }, { sessionId: 's1', projectDir: '/proj' });
    const out = await scratchpadTool.run({ action: 'read' }, { sessionId: 's1', projectDir: '/proj' });
    expect(out).toContain('note one');
    expect(out).toContain('note two');
  });
  it('clear empties the scratchpad', async () => {
    await scratchpadTool.run({ action: 'append', content: 'x' }, { sessionId: 's1', projectDir: '/proj' });
    await scratchpadTool.run({ action: 'clear' }, { sessionId: 's1', projectDir: '/proj' });
    const out = await scratchpadTool.run({ action: 'read' }, { sessionId: 's1', projectDir: '/proj' });
    expect(out).toMatch(/empty/i);
  });
});

describe('memory_add', () => {
  it('appends to MEMORY.md', async () => {
    await memoryAddTool.run({ content: 'Use req()/authReq() for API calls.' }, { projectDir: '/proj' });
    expect([...mockFiles().keys()].some((k) => k.endsWith('/MEMORY.md'))).toBe(true);
  });
});

describe('ask_user', () => {
  it('formats the question (turn-ending)', async () => {
    const out = await askUserTool.run({ question: 'Which DB?', options: ['pg', 'sqlite'] }, { sessionId: 's1' });
    expect(out).toMatch(/Which DB/);
    expect(out).toMatch(/pg/);
  });
});
