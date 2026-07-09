// `memory_add` — append a line to MEMORY.md. When the file exceeds 10 KB,
// automatically compacts via LLM call (pure text-gen, no tools).
// Ported from the multi-file memory_save/read/list/delete tools (removed).

import { native } from 'ugly-app/native';
import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';
import { projectRoot } from './lspForProject';

// Hook for the host (clientAgent) to receive notification after a write so
// it can refresh its own memory content cache for the system prompt injection.
// Set once at init time; never unset.
let onMemoryWrite: ((projectDir: string) => void) | null = null;
export function setMemoryWriteHook(hook: (projectDir: string) => void): void {
  onMemoryWrite = hook;
}

const MEMORY_FILE = 'MEMORY.md';
const MAX_BYTES = 10_000;
const TARGET_BYTES = 8_000; // compact to this size

/** Call the agent's LLM to condense `content` to ≤ TARGET_BYTES. */
async function compactViaLLM(
  ctx: Parameters<ToolModule['run']>[1],
  content: string,
): Promise<string | null> {
  const step = ctx?.step;
  if (!step) return null; // no step function available → can't compact
  try {
    const res = await step({
      messages: [
        {
          role: 'system',
          content:
            'You are a concise memory-keeper. Condense the following memory file into a deduplicated, ' +
            'well-organized Markdown document. Prioritize architecture decisions, deployment config, ' +
            'test infrastructure gotchas, and user preferences. Remove redundant or outdated entries. ' +
            `Keep the total under ${TARGET_BYTES} bytes. Output ONLY the condensed Markdown — no commentary.`,
        },
        { role: 'user', content },
      ],
    });
    const rawContent = res.message.content;
    // AgentMessage.content can be a string or an array of content parts.
    // The compaction response will be plain text, so handle either.
    const condensed = typeof rawContent === 'string' ? rawContent : '';
    // Guard: if the LLM returned something empty or larger, keep the original.
    if (condensed.trim().length === 0) return null;
    if (new TextEncoder().encode(condensed).length > MAX_BYTES) return null;
    return condensed;
  } catch (err) {
    console.error('[memory_add:compact] LLM compaction failed', err);
    return null;
  }
}

export const memoryAddTool: ToolModule = {
  name: 'memory_add',
  spec: {
    name: 'memory_add',
    description:
      'Record a fact you discovered that will be useful across sessions. ' +
      'Appends to MEMORY.md which is injected into every turn\'s system prompt. ' +
      'When the file exceeds 10 KB it is automatically condensed.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'A line of text describing what you learned.',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
  } satisfies TextGenTool,
  async run(input, ctx) {
    const content = (typeof input.content === 'string' ? input.content : '').trim();
    if (!content) return 'memory_add: `content` is required';

    const root = projectRoot(ctx);
    if (!root) return '(no project open)';
    const filePath = `${root.replace(/\/+$/, '')}/${MEMORY_FILE}`;

    // Read existing content (empty string if file doesn't exist)
    let existing = '';
    try {
      existing = await native.fs.readFile(filePath);
    } catch {
      // File doesn't exist yet — that's fine
    }

    // Append the new line
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const updated = existing + separator + content + '\n';

    // Check size and compact if needed
    const sizeBytes = new TextEncoder().encode(updated).length;
    if (sizeBytes > MAX_BYTES) {
      const compacted = await compactViaLLM(ctx, updated);
      if (compacted !== null) {
        await native.fs.writeFile(filePath, compacted);
        onMemoryWrite?.(root);
        const newSize = new TextEncoder().encode(compacted).length;
        const savedKb = Math.round((sizeBytes - newSize) / 1024);
        return `ok (compacted from ${Math.round(sizeBytes / 1024)} KB to ${Math.round(newSize / 1024)} KB, saved ${savedKb} KB)`;
      }
      // Compaction failed or returned bad output — keep the oversized file and warn
      await native.fs.writeFile(filePath, updated);
      onMemoryWrite?.(root);
      return `ok (warning: file is ${Math.round(sizeBytes / 1024)} KB, LLM compaction failed — try again later)`;
    }

    // Size is fine — just write
    await native.fs.writeFile(filePath, updated);
    onMemoryWrite?.(root);
    return 'ok';
  },
};
