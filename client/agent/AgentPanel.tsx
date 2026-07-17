import React from 'react';
import { useAppOptional } from 'ugly-app/client';
import { permissions } from 'ugly-app/native';
import {
  AGENT_BINARIES,
  AGENT_DEFAULT_MODEL,
  type AgentMessage,
} from '../../shared/agent';
import { runAgent, type AgentEvent, type StepFn } from './engine';
import { dispatchTool } from './tools';

interface TranscriptItem {
  kind: 'user' | 'assistant' | 'tool';
  text: string;
  toolName?: string;
  ok?: boolean;
}

/**
 * The coding-agent chat pane. The loop runs client-side (see engine.ts); each
 * model turn is fetched through the `agentStep` endpoint, and tool calls run
 * against the local filesystem/process via the native API.
 */
export default function AgentPanel(): React.ReactElement {
  // Optional: the agent pane must never blank the IDE for a logged-out user.
  const app = useAppOptional();
  const [items, setItems] = React.useState<TranscriptItem[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const historyRef = React.useRef<AgentMessage[]>([]);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const push = (it: TranscriptItem): void => {
    setItems((prev) => [...prev, it]);
  };

  const onEvent = (e: AgentEvent): void => {
    if (e.type === 'assistant') push({ kind: 'assistant', text: e.text });
    else if (e.type === 'tool_call')
      push({ kind: 'tool', toolName: e.name, text: summarizeInput(e.input) });
    else if (e.type === 'tool_result')
      push({
        kind: 'tool',
        toolName: e.name,
        text: e.ok ? '✓' : `✗ ${e.result}`,
        ok: e.ok,
      });
    else if (e.type === 'error')
      push({ kind: 'assistant', text: `⚠ ${e.message}` });
  };

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    push({ kind: 'user', text });
    historyRef.current.push({ role: 'user', content: text });
    setBusy(true);
    try {
      // Idempotent: ensure the agent's binaries are grantable before it runs one.
      // The native facade types `process` as boolean|GrantState, but the desktop
      // daemon accepts a per-binary allowlist (an array on the wire), so cast
      // through to request exactly the bundled binaries the agent uses.
      type GrantReq = Parameters<typeof permissions.request>[0];
      await permissions
        .request({
          fs: 'full',
          process: [...AGENT_BINARIES],
        } as unknown as GrantReq)
        .catch(() => undefined);
      // Test seam: e2e injects a fake step so the full loop runs without a server.
      const override = (globalThis as { __uglyCodeAgentStep?: StepFn })
        .__uglyCodeAgentStep;
      const step: StepFn | undefined =
        override ??
        (app
          ? (req) =>
              app.socket.request('agentStep', req) as Promise<{
                message: AgentMessage;
              }>
          : undefined);
      if (!step) {
        push({ kind: 'assistant', text: '⚠ Sign in to use the agent.' });
        return;
      }
      await runAgent({
        history: historyRef.current,
        step,
        dispatch: dispatchTool,
        model: AGENT_DEFAULT_MODEL,
        onEvent,
      });
    } catch (e) {
      console.error(
        '[AgentPanel:runAgent]',
        JSON.stringify({
          model: AGENT_DEFAULT_MODEL,
          error: e instanceof Error ? e.message : String(e),
        }),
        e instanceof Error ? e.stack : undefined,
      );
      push({ kind: 'assistant', text: `⚠ ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside data-id="agent-panel" style={S.panel}>
      <div style={S.head}>
        <span style={{ color: '#ff6a1f' }}>✦</span> Agent
        {busy && (
          <span data-id="agent-busy" style={S.busy}>
            working…
          </span>
        )}
      </div>
      <div ref={scrollRef} data-id="agent-transcript" style={S.transcript}>
        {items.length === 0 && (
          <div style={S.hint}>
            Ask the agent to read, edit, or run things in your workspace. e.g.
            “List the files here and summarize the project.”
          </div>
        )}
        {items.map((it, i) => (
          <div
            key={i}
            data-id={`agent-${it.kind}`}
            data-tool={it.toolName}
            style={rowStyle(it)}
          >
            {it.kind === 'tool' ? (
              <span>
                <span style={S.toolName}>{it.toolName}</span> {it.text}
              </span>
            ) : (
              it.text
            )}
          </div>
        ))}
      </div>
      <div style={S.composer}>
        <textarea
          data-id="agent-input"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Ask the agent…"
          spellCheck={false}
          style={S.input}
        />
        <button
          data-id="agent-send"
          onClick={() => void send()}
          disabled={busy}
          style={S.send}
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </aside>
  );
}

function summarizeInput(input: unknown): string {
  const p = (input ?? {}) as Record<string, unknown>;
  if (typeof p.path === 'string') return p.path;
  if (typeof p.cmd === 'string')
    return `${p.cmd} ${Array.isArray(p.args) ? p.args.join(' ') : ''}`.trim();
  return '';
}

function rowStyle(it: TranscriptItem): React.CSSProperties {
  if (it.kind === 'user') return S.user;
  if (it.kind === 'tool')
    return { ...S.tool, color: it.ok === false ? '#e0654b' : '#8b8273' };
  return S.assistant;
}

const S = {
  panel: {
    width: 360,
    flex: 'none',
    borderLeft: '1px solid #2c2620',
    display: 'flex',
    flexDirection: 'column',
    background: '#0b0907',
    minHeight: 0,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    borderBottom: '1px solid #2c2620',
    fontFamily: 'monospace',
    fontWeight: 700,
    fontSize: 13,
  },
  busy: { marginLeft: 'auto', fontSize: 11, color: '#ff6a1f', fontWeight: 400 },
  transcript: {
    flex: 1,
    overflow: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minHeight: 0,
  },
  hint: { color: '#5f574c', fontSize: 12, lineHeight: 1.5 },
  user: {
    alignSelf: 'flex-end',
    background: '#ff6a1f',
    color: '#1a0e06',
    borderRadius: 10,
    padding: '7px 11px',
    fontSize: 13,
    maxWidth: '85%',
    whiteSpace: 'pre-wrap',
  },
  assistant: {
    color: '#efe9e1',
    fontSize: 13,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
  },
  tool: { fontFamily: 'monospace', fontSize: 11.5, whiteSpace: 'pre-wrap' },
  toolName: { color: '#ff6a1f' },
  composer: {
    display: 'flex',
    gap: 6,
    padding: 10,
    borderTop: '1px solid #2c2620',
  },
  input: {
    flex: 1,
    background: '#141210',
    color: '#efe9e1',
    border: '1px solid #2c2620',
    borderRadius: 8,
    fontFamily: 'inherit',
    fontSize: 13,
    padding: '8px 10px',
    outline: 'none',
    resize: 'none',
    height: 56,
  },
  send: {
    alignSelf: 'stretch',
    background: '#ff6a1f',
    color: '#1a0e06',
    border: 'none',
    borderRadius: 8,
    padding: '0 14px',
    fontWeight: 700,
    cursor: 'pointer',
  },
} satisfies Record<string, React.CSSProperties>;
