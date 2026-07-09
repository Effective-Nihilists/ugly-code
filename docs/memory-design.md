# Memory Design

## Goal

A dead-simple mechanism for coding agents to remember facts across sessions.
Minimal surface area: one tool, one file, LLM-driven compaction.

## Non-goals (explicitly out of scope)

- Vector search / semantic retrieval
- Per-user or per-session memories
- Real-time sync across devices
- Structured querying

## File

**`MEMORY.md`** at the project root (alongside `package.json`, `.uglyapp`, etc.).

Checked into git so memories survive clone, live in PR diffs, and are editable by
humans. The file is valid Markdown; each appended line is a standalone paragraph.
On compaction the LLM may reorganize into sections, bullet lists, etc.

**Initial state**: absent (tools create it on first write).

## Tool

### `memory_add(content: string)`

1. Read `MEMORY.md` if it exists (empty string otherwise).
2. Append `content` as a new line to the file.
3. If the resulting file **exceeds 10 KB**, call the LLM to condense:
   - System prompt: *"Condense the following memory file into a concise,
     deduplicated version. Use Markdown. Keep the total under 8 KB. Prioritize
     architecture decisions, deployment config, and test infrastructure gotchas."*
   - User message: the current file contents.
   - No tools passed to the step call — pure text generation.
4. Write the (condensed or raw) content back atomically to `MEMORY.md`.
5. Return `"ok"` (or `"ok (compacted from N KB to M KB)"` if compaction ran).

**Edge cases**:
- **File locked / write collision**: Since there's only one writer (the agent
  loop processes one tool call at a time), no concurrent writes.
- **LLM compaction fails** (network error, refused call): fall back — keep the
  oversized file and return `"ok (warning: compaction skipped because ...)"`.
  The agent can retry a manual compaction on the next turn.
- **Calling with empty content**: return `"memory_add: content is required"`.
- **Project not open**: return `"(no project open)"`.

### Removed tools

`memory_read`, `memory_list`, `memory_delete` — no longer needed. The full
content is always in the system prompt (see below), so the agent never needs
to call a read or list tool.

## System prompt injection

Inject the **full content of MEMORY.md** as a section in the system prompt
every turn. Since compaction keeps it ≤8 KB (~2K tokens), this is negligible
overhead for any modern 200K-context model.

```
<MEMORY.md>
{full file contents}
</MEMORY.md>
```

The agent's prompt already tells it what's "memorable" — see the existing
`memoryRead/memoryWrite` feature flags in `GatingFeatures`. No roster, no
thresholds, no branching.

## LLM compaction contract

The compaction call is a plain text-gen step (no tools). The LLM receives the
current file and must return a condensed version. There is no per-entry keying
— compaction is a free-form rewrite. The agent may lose granularity, but it can
always `memory_add` again on the next turn.

**Cost**: ~1–5K input tokens per compaction event. For a typical session that
fills 10 KB of memories over many turns, compaction fires once or twice.

## Migration

1. Delete `client/agent/tools/memory.ts` (the current multi-file implementation).
2. Create new single-tool module `client/agent/tools/memory.ts` with just
   `memoryAddTool` (the spec + `run`).
3. Remove `memory_read`, `memory_list`, `memory_delete` from the tool registry
   and from `gating.ts`.
4. Update `.gitignore` — keep `.ugly-studio/` ignored; `MEMORY.md` is at the
   project root and NOT in `.gitignore`.
5. Wire the system prompt — inject the full MEMORY.md content into the
   agent system prompt every turn.
6. Update `CodingAgentFeatures` — keep `memory: { read, write }` but the
   gating just controls whether `memory_add` is enabled. `memoryRead` still
   gates `memory_add` (since you "read" by reading the file).
7. Commit `.gitignore` change (`.ugly-studio/` → catch-all).
8. Commit the new `MEMORY.md` design doc + implementation.

## Gitignore change

Replace the individual `.ugly-studio/*` rules with a single `/.ugly-studio/`.
`MEMORY.md` lives outside that directory so it's tracked normally.
