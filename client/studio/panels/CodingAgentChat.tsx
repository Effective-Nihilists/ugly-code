import { python } from '@codemirror/lang-python';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { basicSetup, EditorView } from 'codemirror';
import {
  AlertCircle,
  Archive,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  ClipboardList,
  Copy,
  Eye,
  FileText,
  FolderOpen,
  GitBranch,
  GitMerge,
  Globe,
  Lightbulb,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Server,
  ShieldQuestion,
  Square,
  StickyNote,
  TerminalSquare,
  Wrench,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { registerFeedbackContextProvider } from 'ugly-app/client';
import { MdastViewer } from 'ugly-app/markdown/client';
import { isNativeAvailable } from 'ugly-app/native';
import { useVirtualizer } from '../common/hooks/useVirtualizer';
import { formatCurrency } from '../shared/Currency';
import { estimateCost, isSubscriptionProvider } from '../shared/model-rates';
import { AgentAxisSelector } from '../components/AgentAxisSelector';
import { ConsoleText } from '../components/ConsoleText';
import {
  ChatOpenUriProvider,
  inlineLinkStyle,
  LinkifiedText,
  linkifyProse,
  OpenUriContext,
} from '../components/LinkifiedText';
import { SkillPill } from '../components/SkillPill';
import { SlashCommandPopup } from '../components/SlashCommandPopup';
import { useActiveSpec, type ActiveSpec } from '../hooks/useActiveSpec';
import {
  projectAgentMessagesToChat,
  useCodingAgentChat,
  type ChatMessage,
  type PeerLspState,
  type PeerMessage,
  type PeerToolProgress,
  type PendingAskUser,
  type PendingStepReview,
  type PermissionRequest,
  type RawAgentMessage,
  type SubagentChild,
  type ToolUse,
} from '../hooks/useCodingAgentChat';
import { useGitStatus } from '../hooks/useGitStatus';
import { useInputHistory } from '../hooks/useInputHistory';
import {
  useSlashCommands,
  resolveSlashSelection,
  type Skill,
} from '../hooks/useSlashCommands';
import { useSocket, getActiveProjectPath } from '../hooks/useSocket';
import { isTool } from '../../../shared/agent';
import { native } from 'ugly-app/native';
import { useTheme } from '../theme/ThemeProvider';
import { shortcut } from '../utils/platform';
import { timeAgoShort } from '../utils/timeAgo';
import { EvalScorecard } from './EvalScorecard';
import { type FinishFailureInfo } from './FinishFailurePopup';
import { type SubscriptionProvider } from './ModelSelector';
import {
  NewSessionHero,
  type NewSessionStartParams,
} from './NewSessionHero';
import { PatternStrip } from './PatternStrip';
import {
  ReasoningSelector,
  supportsReasoningClient,
} from './ReasoningSelector';
import { capSessionBundle } from './sessionFeedbackBundle';
import { fetchCodebaseStatus } from '../agent/codebaseReadiness';
import { CodebaseStatsModal } from './CodebaseStatsModal';

// ── Shared helpers ──────────────────────────────────────────────────

// Shared 1s ticker — all elapsed timers (BashCard, DevServerCard) share a
// single setInterval instead of each spawning its own. The interval auto-
// starts on first subscription and auto-stops when no one is listening.
let _tickerTimer: ReturnType<typeof setInterval> | null = null;
let _tickerSubs = 0;
const _tickerListeners = new Set<() => void>();

function _ensureTicker(): void {
  if (_tickerTimer) return;
  _tickerTimer = setInterval(() => {
    for (const fn of _tickerListeners) fn();
  }, 1000);
}
function _releaseTicker(): void {
  if (_tickerSubs > 0) return;
  if (_tickerTimer) { clearInterval(_tickerTimer); _tickerTimer = null; }
}

/** Subscribe to a shared 1s heartbeat. Returns the unsubscribe function.
 *  The interval auto-starts/stops so zero-card scenarios use zero CPU. */
function subscribeTicker(fn: () => void): () => void {
  _tickerListeners.add(fn);
  _tickerSubs++;
  _ensureTicker();
  return () => {
    _tickerListeners.delete(fn);
    _tickerSubs--;
    _releaseTicker();
  };
}

/** Safe clipboard write with a brief visual ack via setter. */
function useCopyButton(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((key: string, text: string) => {
    try {
      void navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => { setCopied((c) => (c === key ? null : c)); }, 1200);
    } catch {
      /* ignore */
    }
  }, []);
  return [copied, copy];
}

const copyButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '2px 6px',
  fontSize: 10,
  color: 'var(--text-muted)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
};

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, copy] = useCopyButton();
  const isCopied = copied === 'self';
  return (
    <button
      data-id="copy-button"
      type="button"
      style={copyButtonStyle}
      onClick={(e) => {
        e.stopPropagation();
        copy('self', text);
      }}
      title={isCopied ? 'Copied' : 'Copy to clipboard'}
    >
      {isCopied ? <Check size={10} /> : <Copy size={10} />}
      {label ?? (isCopied ? 'Copied' : 'Copy')}
    </button>
  );
}

/**
 * Header icon button — copies the active session's compositeId (the
 * `ws_…:sess_…` string) to the clipboard. Sits next to the Archive
 * button so a user filing a bug report or sharing context with
 * support can grab the id with one click instead of digging through
 * sidebar URLs. Uses the themed `data-us-tooltip` bubble (see
 * `styles.css`) instead of `title=` so dark-mode users don't see
 * the OS's white-on-light native tooltip.
 */
// Tools whose output is usually worth seeing at a glance — shell opens them
// by default. Everything else starts collapsed.
const DEFAULT_EXPANDED_TOOLS = new Set([
  'bash',
  'delegate',
  'delegate_parallel',
  'python',
  'write',
  'multiedit',
  'think',
]);

function isDefaultExpanded(name: string): boolean {
  return DEFAULT_EXPANDED_TOOLS.has(name.toLowerCase());
}

/** Shared card shell. Owns expand state, header click, and chevron placement
 *  so every tool card — generic and bespoke — looks the same. */
function ToolCardShell({
  icon,
  title,
  subtitle,
  status,
  children,
  headerExtras,
  defaultExpanded = false,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  status?: ToolUse['status'];
  children: React.ReactNode;
  headerExtras?: React.ReactNode;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Debounce the "running" visual treatment so tools that finish in
  // <500ms don't briefly flash as orange before settling into done.
  const [showRunning, setShowRunning] = useState(false);
  useEffect(() => {
    if (status === 'running' || status === 'executing') {
      const t = setTimeout(() => { setShowRunning(true); }, 500);
      return () => { clearTimeout(t); };
    }
    setShowRunning(false);
  }, [status]);
  const running = showRunning;
  return (
    <div
      style={{
        border: `1px solid ${running ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 8,
        background: running ? 'rgba(255,85,0,0.04)' : 'var(--bg-secondary)',
        overflow: 'hidden',
        fontSize: 12,
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      <div
        data-id="tool-result-toggle"
        onClick={() => { setExpanded(!expanded); }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '3px 10px',
          cursor: 'pointer',
          lineHeight: 1.4,
          userSelect: 'none',
        }}
      >
        <span
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            color: 'var(--text-muted)',
          }}
        >
          {icon}
        </span>
        <span
          style={{
            fontWeight: 600,
            color: 'var(--text-primary)',
            flexShrink: 0,
          }}
        >
          {title}
        </span>
        <span
          style={{
            color: 'var(--text-muted)',
            fontSize: 11,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {subtitle}
        </span>
        {headerExtras}
        <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {running && (
            <Loader2
              size={12}
              className="us-spin"
              style={{ color: 'var(--accent)' }}
            />
          )}
          {status === 'done' && (
            <Check size={12} style={{ color: 'var(--success)' }} />
          )}
          {status === 'error' && (
            <X size={12} style={{ color: 'var(--error)' }} />
          )}
        </span>
        <span
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            color: 'var(--text-muted)',
          }}
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </div>
      <div className="us-collapse" data-open={expanded}>
        <div style={{ borderTop: '1px solid var(--border)' }}>{children}</div>
      </div>
    </div>
  );
}

// ── Tool icons (Lucide) ─────────────────────────────────────────────
//
// One entry per tool currently in the active catalog (see
// studio/server/coding-agent/tools/tool-specs.ts TOOL_NAMES). Tools
// not in the map fall through to a generic Wrench. Keep this list
// in sync with the catalog when tools are added or retired —
// stale icons here aren't load-bearing but render `Wrench` for
// anything missing, which leaks "this is unrecognized" to the user.

const TOOL_ICON_MAP: Record<string, React.ReactNode> = {
  // File I/O
  read: <FileText size={13} />,
  edit: <Pencil size={13} />,
  multiedit: <Pencil size={13} />,
  write: <Pencil size={13} />,
  // Search / discovery
  glob: <Search size={13} />,
  grep: <Search size={13} />,
  tool_search: <Search size={13} />,
  // Shell / code execution
  bash: <TerminalSquare size={13} />,
  python_exec: <TerminalSquare size={13} />,
  python_libraries: <FolderOpen size={13} />,
  // Web
  web_fetch: <Globe size={13} />,
  web_search: <Globe size={13} />,
  // Dev server
  dev_server_start: <Zap size={13} />,
  dev_server_stop: <Square size={13} />,
  dev_server_logs: <TerminalSquare size={13} />,
  dev_server_errors: <ShieldQuestion size={13} />,
  // Project DB
  database: <Zap size={13} />,
  database_sql_query: <Zap size={13} />,
  // Vision / image
  analyze_image: <Eye size={13} />,
  // Sub-agents
  delegate: <GitBranch size={13} />,
  delegate_parallel: <GitBranch size={13} />,
  // Memory + scratchpad
  memory_add: <Lightbulb size={13} />,
  scratchpad: <StickyNote size={13} />,
  // Specs
  spec_read: <ClipboardList size={13} />,
  spec_write: <ClipboardList size={13} />,
  // Planning
  todos: <CheckSquare size={13} />,
  // Wishlist + meta
  tool_request: <Plus size={13} />,
  // Misc
  dep_docs: <FileText size={13} />,
  ask_user: <ShieldQuestion size={13} />,
};

function getToolIcon(name: string): React.ReactNode {
  return TOOL_ICON_MAP[name] ?? <Wrench size={13} />;
}

function firstLine(s: string, max = 200): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

function formatToolInput(
  name: string,
  input: string,
  cwd = '',
): React.ReactNode {
  try {
    const parsed = JSON.parse(input) as ToolInput;
    // Single-task / prompt-style tools — show the task text, not JSON.
    if (typeof parsed.task === 'string') return firstLine(parsed.task);
    if (typeof parsed.prompt === 'string') return firstLine(parsed.prompt);
    if (Array.isArray(parsed.tasks)) {
      const n = parsed.tasks.length;
      return `${n} task${n === 1 ? '' : 's'}${
        parsed.tasks[0] ? ` · ${firstLine(parsed.tasks[0], 120)}` : ''
      }`;
    }
    if (typeof parsed.code === 'string') return firstLine(parsed.code);
    if (typeof parsed.url === 'string') return parsed.url;
    // Path-bearing tools (`read`, `dep_docs`, …) render the path as a link,
    // matching EditCard. `offset` is a 1-based start line, so a clicked
    // `read` opens the file where the agent was looking.
    if (parsed.file_path) {
      const range =
        parsed.offset != null || parsed.limit != null
          ? ` (${parsed.offset ?? 0}+${parsed.limit ?? '?'})`
          : '';
      return (
        <span title={parsed.file_path}>
          <LinkedPath path={parsed.file_path} line={parsed.offset}>
            {relativizePath(parsed.file_path, cwd)}
          </LinkedPath>
          {range}
        </span>
      );
    }
    if (parsed.command) return parsed.command;
    if (parsed.pattern) return parsed.pattern;
    if (parsed.query) return parsed.query;
    if (parsed.path)
      return (
        <span title={parsed.path}>
          <LinkedPath path={parsed.path}>
            {relativizePath(parsed.path, cwd)}
          </LinkedPath>
        </span>
      );
    if (parsed.sql) return parsed.sql;
    return input.length > 200 ? input.slice(0, 200) + '...' : input;
  } catch {
    return input.length > 200 ? input.slice(0, 200) + '...' : input;
  }
}

/** Strip the `<file>...</file>` wrapper emitted by the view tool. */
function unwrapViewResult(text: string): string {
  const m = /^<file>\n?([\s\S]*?)\n?<\/file>\n?/.exec(text);
  return m ? m[1] : text;
}

/** Small section label used inside tool card bodies. */
function SectionLabel({
  children,
  copyText,
  accent,
}: {
  children: React.ReactNode;
  copyText?: string;
  accent?: 'muted' | 'success' | 'error' | 'accent';
}) {
  const color =
    accent === 'success'
      ? 'var(--success)'
      : accent === 'error'
      ? 'var(--error)'
      : accent === 'accent'
      ? 'var(--accent)'
      : 'var(--text-muted)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 2,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      <span
        style={{
          color,
          fontWeight: 600,
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}
      >
        {children}
      </span>
      {copyText && <CopyButton text={copyText} />}
    </div>
  );
}

/** Read-only CodeMirror view. Used for the `python` tool's code input so
 *  users get real syntax highlighting instead of a raw <pre> dump. */
function CodeView({ text, language }: { text: string; language: 'python' }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { mode } = useTheme();
  const isDark = mode === 'dark';

  useEffect(() => {
    if (!hostRef.current) return;
    const langExt = python();
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          langExt,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          ...(isDark ? [oneDark] : []),
          EditorView.theme({
            '&': { fontSize: '11px', background: 'transparent' },
            '.cm-scroller': {
              fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
            },
            '.cm-gutters': { background: 'transparent', border: 'none' },
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [isDark, language]);

  // Keep the doc in sync when streaming updates come in.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== text) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: text } });
    }
  }, [text]);

  return (
    <div
      ref={hostRef}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg-primary)',
        overflow: 'hidden',
      }}
    />
  );
}

/** Render the tool's input in the format that matches its shape.
 *  Falls back to raw JSON for unrecognized tools. */
function ToolInputView({ tool }: { tool: ToolUse }) {
  const parsed = safeParse(tool.input);
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.task === 'string') {
      return (
        <>
          <SectionLabel copyText={parsed.task}>Task</SectionLabel>
          <ChatMarkdown text={parsed.task} />
        </>
      );
    }
    if (typeof parsed.prompt === 'string') {
      return (
        <>
          <SectionLabel copyText={parsed.prompt}>Prompt</SectionLabel>
          <ChatMarkdown text={parsed.prompt} />
        </>
      );
    }
    if (Array.isArray(parsed.tasks)) {
      return (
        <>
          <SectionLabel>Tasks · {parsed.tasks.length}</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {parsed.tasks.map((t: string, i: number) => (
              <div key={i} style={{ display: 'flex', gap: 8, minWidth: 0 }}>
                <span
                  style={{
                    color: 'var(--text-muted)',
                    fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0,
                  }}
                >
                  {i + 1}.
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <ChatMarkdown text={t} />
                </div>
              </div>
            ))}
          </div>
        </>
      );
    }
    if (typeof parsed.code === 'string') {
      return (
        <>
          <SectionLabel copyText={parsed.code}>Code</SectionLabel>
          <CodeView text={parsed.code} language="python" />
        </>
      );
    }
    if (typeof parsed.url === 'string') {
      return (
        <>
          <SectionLabel>URL</SectionLabel>
          <a
            data-id="tool-input-url-link"
            href={parsed.url}
            target="_blank"
            rel="noreferrer"
            style={{
              color: 'var(--accent)',
              fontSize: 11,
              fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
              wordBreak: 'break-all',
            }}
          >
            {parsed.url}
          </a>
        </>
      );
    }
  }
  return (
    <>
      <SectionLabel copyText={tool.input}>Input</SectionLabel>
      <pre
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--text-secondary)',
          fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
          fontSize: 11,
        }}
      >
        <LinkifiedText text={tool.input} />
      </pre>
    </>
  );
}

/** Render the tool's result based on the tool it came from. */
function ToolOutputView({ tool }: { tool: ToolUse }) {
  if (!tool.result) return null;
  const name = tool.name.toLowerCase();
  const isError = tool.status === 'error';

  // delegate — result is prose (often markdown). Render it.
  if (!isError && isTool(name, 'delegate')) {
    return (
      <>
        <SectionLabel copyText={tool.result} accent="accent">
          Summary
        </SectionLabel>
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--text-secondary)',
          }}
        >
          {renderAssistantContent(tool.result)}
        </div>
      </>
    );
  }

  // delegate_parallel — result is a JSON array of child summaries.
  if (!isError && isTool(name, 'delegate_parallel')) {
    let arr: DelegateSummary[] | null = null;
    try {
      const raw: unknown = JSON.parse(tool.result);
      if (Array.isArray(raw)) arr = raw as DelegateSummary[];
    } catch {
      arr = null;
    }
    if (Array.isArray(arr)) {
      return (
        <>
          <SectionLabel accent="accent">Summaries · {arr.length}</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {arr.map((entry, i) => (
              <div
                key={i}
                style={{
                  borderLeft: '2px solid var(--border)',
                  paddingLeft: 8,
                }}
              >
                <div
                  style={{
                    color: 'var(--text-muted)',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    marginBottom: 2,
                  }}
                >
                  Task {entry.task_index ?? i}
                  {entry.iterations_used != null && (
                    <> · {entry.iterations_used} iter</>
                  )}
                  {entry.aborted && <> · aborted</>}
                </div>
                {entry.error ? (
                  <div style={{ color: 'var(--error)', fontSize: 12 }}>
                    {entry.error}
                  </div>
                ) : entry.summary ? (
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {renderAssistantContent(entry.summary)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      );
    }
  }

  // read — strip the <file>...</file> wrapper for readability.
  if (isTool(name, 'read')) {
    const body = unwrapViewResult(tool.result);
    return (
      <>
        <SectionLabel copyText={body}>File</SectionLabel>
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre',
            overflowX: 'auto',
            color: 'var(--text-secondary)',
            fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
            fontSize: 11,
          }}
        >
          <LinkifiedText text={body} />
        </pre>
      </>
    );
  }

  return (
    <>
      <SectionLabel copyText={tool.result}>
        {isError ? 'Error' : 'Result'}
      </SectionLabel>
      <pre
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: isError ? 'var(--error)' : 'var(--text-secondary)',
          fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
          fontSize: 11,
        }}
      >
        <ConsoleText
          text={tool.result}
          errorTone={isError}
          TextComponent={LinkifiedText}
        />
      </pre>
    </>
  );
}

// ── Todo Card (special-case TodoWrite) ──────────────────────────────

interface TodoSuccessCriteria {
  description: string;
  command?: string;
  file_contains?: { path: string; needle: string };
  file_not_contains?: { path: string; needle: string };
}

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
  successCriteria?: TodoSuccessCriteria;
}

interface RawFileCheck {
  path?: unknown;
  needle?: unknown;
}
interface RawSuccessCriteria {
  description?: unknown;
  command?: unknown;
  file_contains?: RawFileCheck;
  file_not_contains?: RawFileCheck;
}
interface RawTodo {
  content?: unknown;
  status?: unknown;
  activeForm?: unknown;
  active_form?: unknown;
  success_criteria?: RawSuccessCriteria;
  successCriteria?: RawSuccessCriteria;
}

function parseTodos(input: string): TodoItem[] | null {
  try {
    const parsed = JSON.parse(input) as { todos?: unknown };
    const todos = parsed.todos;
    if (!Array.isArray(todos) || todos.length === 0) return null;
    return (todos as RawTodo[])
      .filter((t) => typeof t.content === 'string')
      .map((t): TodoItem => {
        const sc = t.success_criteria ?? t.successCriteria;
        const criteria: TodoSuccessCriteria | undefined =
          sc && typeof sc.description === 'string'
            ? {
                description: sc.description,
                ...(typeof sc.command === 'string'
                  ? { command: sc.command }
                  : {}),
                ...(sc.file_contains &&
                typeof sc.file_contains.path === 'string' &&
                typeof sc.file_contains.needle === 'string'
                  ? {
                      file_contains: {
                        path: sc.file_contains.path,
                        needle: sc.file_contains.needle,
                      },
                    }
                  : {}),
                ...(sc.file_not_contains &&
                typeof sc.file_not_contains.path === 'string' &&
                typeof sc.file_not_contains.needle === 'string'
                  ? {
                      file_not_contains: {
                        path: sc.file_not_contains.path,
                        needle: sc.file_not_contains.needle,
                      },
                    }
                  : {}),
              }
            : undefined;
        return {
          content: t.content as string,
          status: t.status as TodoItem['status'],
          activeForm: (t.activeForm ?? t.active_form) as string | undefined,
          ...(criteria ? { successCriteria: criteria } : {}),
        };
      });
  } catch {
    return null;
  }
}

// Walk `messages[from..to]` (inclusive) backwards and return the most
// recent parsed `todos`/`todowrite` tool input. Used both for the
// pinned live bar and for the per-turn final-state snapshot rendered
// inline once a turn has ended.
function findTurnTodos(
  messages: ChatMessage[],
  from: number,
  to: number,
): TodoItem[] | null {
  if (to >= messages.length) to = messages.length - 1;
  if (from < 0) from = 0;
  for (let i = to; i >= from; i--) {
    const msg = messages[i];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access can be undefined at runtime (noUncheckedIndexedAccess is off)
    if (!msg?.toolUses || msg.toolUses.length === 0) continue;
    for (let j = msg.toolUses.length - 1; j >= 0; j--) {
      const tool = msg.toolUses[j];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access can be undefined at runtime (noUncheckedIndexedAccess is off)
      if (!tool) continue;
      const lower = tool.name.toLowerCase();
      if (lower === 'todos' || lower === 'todowrite') {
        const parsed = parseTodos(tool.input);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

function TodoCard({
  todos,
  isStreaming,
}: {
  todos: TodoItem[];
  isStreaming?: boolean;
}) {
  const completed = todos.filter((t) => t.status === 'completed').length;
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--bg-secondary)',
        overflow: 'hidden',
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          color: 'var(--text-muted)',
          borderBottom: '1px solid var(--border)',
          fontSize: 10,
          textTransform: 'uppercase',
          fontWeight: 600,
          letterSpacing: 0.3,
        }}
      >
        <CheckSquare size={12} />
        <span>
          Todos · {completed}/{todos.length}
        </span>
      </div>
      <TodoList todos={todos} isStreaming={isStreaming} />
    </div>
  );
}

// Bare list of todo items — no card chrome (no border, bg, or header).
// Used standalone inside `PinnedTodos` (whose own header replaces the
// per-card "Todos · X/Y") and inside `TodoCard` for past-snapshot
// renders that DO want the card wrapper.
function TodoList({
  todos,
  isStreaming,
}: {
  todos: TodoItem[];
  isStreaming?: boolean;
}) {
  return (
    <div
      data-id="todo-list"
      style={{
        padding: '6px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        fontSize: 12,
        background: 'var(--bg-secondary)',
        borderRadius: 8,
        margin: '8px 0',
      }}
    >
      {todos.map((todo, i) => {
        const isDone = todo.status === 'completed';
        const isActive = todo.status === 'in_progress';
        // When the session isn't streaming anymore, an in_progress
        // todo represents work the agent abandoned mid-turn. Render
        // it as paused (CircleDot, muted color, no spin) so the user
        // can tell at a glance that nothing is actually running. The
        // todo's underlying status stays in_progress so the agent
        // can pick it up again on the next turn.
        const isPaused = isActive && isStreaming === false;
        const label =
          isActive && todo.activeForm ? todo.activeForm : todo.content;
        const sc = todo.successCriteria;
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              lineHeight: 1.5,
            }}
          >
            <span
              style={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                marginTop: 2,
              }}
              title={
                isPaused ? 'Paused — turn ended before completion' : undefined
              }
            >
              {isDone && (
                <Check size={12} style={{ color: 'var(--success)' }} />
              )}
              {isActive && !isPaused && (
                <Loader2
                  size={12}
                  className="us-spin"
                  style={{ color: 'var(--accent)' }}
                />
              )}
              {isPaused && (
                <CircleDot size={12} style={{ color: 'var(--text-muted)' }} />
              )}
              {todo.status === 'pending' && (
                <Circle size={12} style={{ color: 'var(--text-muted)' }} />
              )}
            </span>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                minWidth: 0,
                flex: 1,
              }}
            >
              <span
                style={{
                  color: isDone
                    ? 'var(--text-muted)'
                    : isPaused
                    ? 'var(--text-secondary)'
                    : isActive
                    ? 'var(--text-primary)'
                    : 'var(--text-secondary)',
                  textDecoration: isDone ? 'line-through' : 'none',
                  fontWeight: isActive && !isPaused ? 600 : 400,
                  wordBreak: 'break-word',
                }}
              >
                {label}
              </span>
              {sc && (
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    lineHeight: 1.4,
                    paddingLeft: 0,
                  }}
                >
                  <div style={{ wordBreak: 'break-word' }}>
                    ↳ {sc.description}
                  </div>
                  {sc.command && (
                    <div
                      style={{
                        fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
                        wordBreak: 'break-all',
                      }}
                    >
                      ✓ <code>{sc.command}</code>
                    </div>
                  )}
                  {sc.file_contains && (
                    <div
                      style={{
                        fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
                        wordBreak: 'break-all',
                      }}
                    >
                      ✓ <code>{sc.file_contains.path}</code> contains{' '}
                      <code>{JSON.stringify(sc.file_contains.needle)}</code>
                    </div>
                  )}
                  {sc.file_not_contains && (
                    <div
                      style={{
                        fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
                        wordBreak: 'break-all',
                      }}
                    >
                      ✗ <code>{sc.file_not_contains.path}</code> must not
                      contain{' '}
                      <code>{JSON.stringify(sc.file_not_contains.needle)}</code>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Pinned Todos ────────────────────────────────────────────────────
//
// Renders the agent's current todo list pinned at the top of the
// messages scroll area. Derived from the most recent `todos` tool call
// in the transcript via useMemo — no new server event needed. Uses
// position: sticky inside the scroll container so it stays visible
// while the user scrolls earlier history. Collapses on header click.
// Hidden entirely when the agent hasn't called `todos` yet.

function PinnedTodos({
  todos,
  isStreaming,
}: {
  todos: TodoItem[];
  isStreaming?: boolean;
}) {
  // Default expanded: the todo list is the agent's live progress
  // report; showing it upfront is worth more than the couple lines
  // of chat-header space it consumes. Users can collapse via the
  // header click if they want the extra room for messages.
  const [collapsed, setCollapsed] = useState(false);
  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const inProgress = todos.find((t) => t.status === 'in_progress');
  const nextPending = todos.find((t) => t.status === 'pending');
  const currentTask = inProgress ?? nextPending;
  const allDone = completed === total && total > 0;
  if (todos.length === 0 || allDone) return null;
  const currentLabel = currentTask
    ? inProgress
      ? inProgress.activeForm ?? inProgress.content
      : currentTask.content
    : null;
  return (
    <div
      style={{
        background: 'var(--bg-primary, var(--bg-secondary))',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}
    >
      <div
        data-id="diff-block-toggle"
        onClick={() => { setCollapsed((c) => !c); }}
        style={{
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
          color: 'var(--text-muted)',
          userSelect: 'none',
        }}
      >
        <CheckSquare size={12} />
        <span>
          Progress · {completed}/{total}
        </span>
        {currentLabel && (
          <span
            style={{
              fontWeight: 400,
              textTransform: 'none',
              letterSpacing: 0,
              color: 'var(--text-secondary)',
              marginLeft: 4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
            }}
          >
            {currentLabel}
          </span>
        )}
        <span
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            color: 'var(--text-muted)',
          }}
        >
          {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </span>
      </div>
      {/* `us-collapse` keeps the panel mounted so close also animates.
          Renders <TodoList> directly — no inner card chrome. The
          PinnedTodos header above already plays the role TodoCard's
          inner header used to. */}
      <div className="us-collapse" data-open={!collapsed}>
        <TodoList todos={todos} isStreaming={isStreaming} />
      </div>
    </div>
  );
}

// ── Edit / Write / MultiEdit Card ──────────────────────────────────

/** One entry in an agent session's scratchpad (server-persisted). */
interface ScratchpadEntry {
  key: string;
  value: string;
  mergeToMemory: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Loosely-typed shape of a tool call's `metadata` (server-parsed). */
interface ToolMetadata {
  // Numeric fields are coerced via Number() at call sites because the
  // server may serialize them as strings; keep the union so those
  // defensive conversions stay meaningful.
  additions?: number | string;
  removals?: number | string;
  edits?: number | string;
  edits_applied?: number | string;
  count?: number;
  diff?: string;
  new_content?: string;
  old_content?: string;
  number_of_matches?: number | string;
  start_time?: number | string;
  end_time?: number | string;
  truncated?: boolean;
}

/** One child summary from a `delegate_parallel` tool result. */
interface DelegateSummary {
  task_index?: number;
  iterations_used?: number;
  aborted?: boolean;
  error?: string;
  summary?: string;
}

/** One entry in a `multiedit` / `edit` tool call's parsed input. */
interface ToolInputEdit {
  old_string?: string;
  new_string?: string;
  new_content?: string;
  anchor?: string;
  insert_after?: string | number;
  range?: string;
  replace_all?: boolean;
}

/**
 * Loosely-typed shape of a tool call's parsed JSON input. Every field is
 * optional — the agent emits different keys per tool. Access is safe
 * because reads are guarded (`typeof x === 'string'`) or defaulted.
 */
interface ToolInput {
  task?: string;
  prompt?: string;
  tasks?: string[];
  code?: string;
  url?: string;
  file_path?: string;
  offset?: number;
  limit?: number;
  command?: string;
  pattern?: string;
  query?: string;
  sql?: string;
  path?: string;
  old_string?: string;
  new_string?: string;
  new_content?: string;
  edits?: ToolInputEdit[];
  thought?: string;
  filter?: string;
  timeout_ms?: number;
  include?: string;
}

function safeParse(raw: string): ToolInput | null {
  try {
    return JSON.parse(raw) as ToolInput;
  } catch {
    return null;
  }
}

function describeEditTarget(e: ToolInputEdit): string | undefined {
  if (typeof e.old_string === 'string') {
    const oneLine = e.old_string.replace(/\n/g, ' ⏎ ');
    return oneLine.length > 80
      ? `match: ${oneLine.slice(0, 80)}…`
      : `match: ${oneLine}`;
  }
  if (typeof e.anchor === 'string') return `anchor: ${e.anchor}`;
  if (e.insert_after !== undefined) return `insert after: ${e.insert_after}`;
  if (typeof e.range === 'string') return `range: ${e.range}`;
  return undefined;
}

function EditCard({ tool }: { tool: ToolUse }) {
  const cwd = useChatCwd();
  const input = safeParse(tool.input) ?? {};
  const meta = (tool.metadata ?? {}) as ToolMetadata;
  // The edit/write/multiedit tool schemas name the parameter `path` (see
  // shared/agent.ts); `file_path` is only a legacy alias. Read both so the card
  // header shows the real path instead of "(unknown path)".
  const filePath: string = input.file_path ?? input.path ?? '(unknown path)';
  const isWrite = isTool(tool.name.toLowerCase(), 'write');
  const isMulti = isTool(tool.name.toLowerCase(), 'multiedit');
  const additions = Number(meta.additions ?? 0);
  const removals = Number(meta.removals ?? 0);
  const editsApplied = Number(meta.edits ?? meta.edits_applied ?? 0);
  // Prefer the diff/metadata from the server, fall back to the raw input
  // strings. Edits using anchor modes (`anchor` / `insert_after` / `range`)
  // pass replacement content as `new_content`; string-match mode uses
  // `new_string`. The `write` tool also uses `new_content`. Surface either.
  const oldContent: string | undefined = meta.old_content ?? input.old_string;
  const newContent: string | undefined =
    meta.new_content ?? input.new_string ?? input.new_content;
  const targetDescription = !isMulti ? describeEditTarget(input) : undefined;
  const diffText: string | undefined = meta.diff;
  // Capture the multi-edit array once: TS loses the `Array.isArray` narrowing on
  // `input.edits` inside the .map() closure below (property narrowing doesn't
  // survive a callback boundary even though `input` is const), so hoist it.
  const multiEdits = isMulti && Array.isArray(input.edits) ? input.edits : [];

  // Display the cwd-relative form when the file lives inside the
  // session worktree (the typical case). Falls back to the absolute
  // path for tool calls that target /tmp / system paths.
  const shortPath = relativizePath(filePath, cwd);

  return (
    <ToolCardShell
      icon={<Pencil size={13} />}
      title={tool.name}
      subtitle={
        <span title={filePath}>
          <LinkedPath path={filePath}>{shortPath}</LinkedPath>
          {isMulti && editsApplied > 0 && (
            <>
              {' '}
              · {editsApplied} edit{editsApplied === 1 ? '' : 's'}
            </>
          )}
          {(additions > 0 || removals > 0) && (
            <>
              {' '}
              <span style={{ color: 'var(--success)' }}>+{additions}</span>{' '}
              <span style={{ color: 'var(--error)' }}>-{removals}</span>
            </>
          )}
        </span>
      }
      status={tool.status}
      defaultExpanded={isDefaultExpanded(tool.name)}
    >
      <div
        style={{
          padding: '8px 10px',
          fontSize: 11,
          fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
          maxHeight: 360,
          overflow: 'auto',
        }}
      >
        {diffText ? (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 4,
                fontFamily: 'Inter, sans-serif',
              }}
            >
              <span
                style={{
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                  fontSize: 10,
                  textTransform: 'uppercase',
                }}
              >
                Diff
              </span>
              <CopyButton text={diffText} />
            </div>
            <DiffBlock text={diffText} />
          </>
        ) : isWrite && newContent ? (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 4,
                fontFamily: 'Inter, sans-serif',
              }}
            >
              <span
                style={{
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                  fontSize: 10,
                  textTransform: 'uppercase',
                }}
              >
                New file
              </span>
              <CopyButton text={newContent} />
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--text-secondary)',
              }}
            >
              <LinkifiedText text={newContent} />
            </pre>
          </>
        ) : multiEdits.length > 0 ? (
          <>
            {multiEdits.map((e, i: number) => {
              const target = describeEditTarget(e);
              const newStr = e.new_string ?? e.new_content;
              return (
                <div
                  key={i}
                  style={{ marginBottom: i < multiEdits.length - 1 ? 12 : 0 }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      marginBottom: 4,
                      fontFamily: 'Inter, sans-serif',
                    }}
                  >
                    Edit {i + 1} / {multiEdits.length}
                    {e.replace_all ? ' · replace all' : ''}
                    {target ? (
                      <span
                        style={{
                          marginLeft: 6,
                          color: 'var(--text-muted)',
                          fontWeight: 400,
                          textTransform: 'none',
                          fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
                        }}
                      >
                        {target}
                      </span>
                    ) : null}
                  </div>
                  <EditBeforeAfter oldStr={e.old_string} newStr={newStr} />
                </div>
              );
            })}
          </>
        ) : oldContent || newContent ? (
          <>
            {targetDescription ? (
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  marginBottom: 4,
                  fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
                }}
              >
                {targetDescription}
              </div>
            ) : null}
            <EditBeforeAfter oldStr={oldContent} newStr={newContent} />
          </>
        ) : (
          <div style={{ color: 'var(--text-muted)' }}>
            No diff available yet.
          </div>
        )}
        {tool.result && (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: 8,
                marginBottom: 2,
                fontFamily: 'Inter, sans-serif',
              }}
            >
              <span
                style={{
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                  fontSize: 10,
                  textTransform: 'uppercase',
                }}
              >
                Output
              </span>
              <CopyButton text={tool.result} />
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color:
                  tool.status === 'error'
                    ? 'var(--error)'
                    : 'var(--text-secondary)',
                fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
                fontSize: 11,
              }}
            >
              <ConsoleText
                text={tool.result}
                errorTone={tool.status === 'error'}
                TextComponent={LinkifiedText}
              />
            </pre>
          </>
        )}
      </div>
    </ToolCardShell>
  );
}

function EditBeforeAfter({
  oldStr,
  newStr,
}: {
  oldStr?: string;
  newStr?: string;
}) {
  if (!oldStr && !newStr) return null;
  return (
    <>
      {oldStr && (
        <div style={{ marginBottom: newStr ? 8 : 0 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: 2,
              fontFamily: 'Inter, sans-serif',
            }}
          >
            <span
              style={{
                color: 'var(--error)',
                fontWeight: 600,
                fontSize: 10,
                textTransform: 'uppercase',
              }}
            >
              Before
            </span>
            <CopyButton text={oldStr} />
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-secondary)',
              background: 'rgba(227,18,11,0.06)',
              padding: '4px 6px',
              borderRadius: 4,
            }}
          >
            {oldStr}
          </pre>
        </div>
      )}
      {newStr && (
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: 2,
              fontFamily: 'Inter, sans-serif',
            }}
          >
            <span
              style={{
                color: 'var(--success)',
                fontWeight: 600,
                fontSize: 10,
                textTransform: 'uppercase',
              }}
            >
              After
            </span>
            <CopyButton text={newStr} />
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-secondary)',
              background: 'rgba(30,180,90,0.06)',
              padding: '4px 6px',
              borderRadius: 4,
            }}
          >
            {newStr}
          </pre>
        </div>
      )}
    </>
  );
}

function DiffBlock({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre', overflowX: 'auto' }}>
      {lines.map((line, i) => {
        let color = 'var(--text-secondary)';
        let bg: string | undefined;
        if (line.startsWith('+') && !line.startsWith('+++')) {
          color = 'var(--success)';
          bg = 'rgba(30,180,90,0.08)';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          color = 'var(--error)';
          bg = 'rgba(227,18,11,0.08)';
        } else if (line.startsWith('@@')) color = 'var(--accent)';
        return (
          <div
            key={i}
            style={{ color, background: bg, padding: bg ? '0 4px' : undefined }}
          >
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

// ── Bash Card ──────────────────────────────────────────────────────

// ── Think Card ──────────────────────────────────────────────────────
//
// Renders the `think` tool call as a distinct reasoning callout rather
// than a generic collapsed tool card. The model uses `think` as a
// scratchpad for non-obvious decisions, and we want the thought itself
// front-and-center in the transcript so the user can follow along with
// the agent's reasoning. Always expanded by default.

function ThinkCard({ tool }: { tool: ToolUse }) {
  const input = safeParse(tool.input) ?? {};
  const thought: string =
    typeof input.thought === 'string' ? input.thought : tool.input;
  return (
    <div
      style={{
        margin: '6px 0',
        padding: '10px 12px',
        borderRadius: 6,
        border: '1px solid var(--border, #3a3a3a)',
        background:
          'color-mix(in srgb, var(--warning, #d97706) 7%, transparent)',
        borderLeft: '3px solid var(--warning, #d97706)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 6,
          color: 'var(--warning, #d97706)',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}
      >
        <Lightbulb size={13} />
        <span>thinking</span>
      </div>
      <div
        style={{
          fontSize: 13,
          fontStyle: 'italic',
          color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.5,
        }}
      >
        {thought}
      </div>
    </div>
  );
}

function BashCard({
  tool,
  onStop,
}: {
  tool: ToolUse;
  onStop?: (toolCallId: string) => void;
}) {
  const input = safeParse(tool.input) ?? {};
  const filter: string | undefined =
    typeof input.filter === 'string' && input.filter.length > 0
      ? input.filter
      : undefined;
  const meta = (tool.metadata ?? {}) as ToolMetadata;
  const command: string = input.command ?? tool.input;
  // While the tool is still executing, show the streamed `liveOutput`.
  // Once the final `tool_result` lands, `result` takes over — which may
  // be a filter-narrowed view when the model passed a `filter` arg.
  const displayOutput =
    tool.status === 'executing' && tool.liveOutput
      ? tool.liveOutput
      : tool.result ?? '';
  const result = tool.result ?? '';
  const exitMatch = /Exit code (\d+)/.exec(result);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
  const durationMs =
    meta.start_time && meta.end_time
      ? Number(meta.end_time) - Number(meta.start_time)
      : null;
  const running = tool.status === 'running' || tool.status === 'executing';
  // Live elapsed timer for running commands. Uses a shared 1Hz ticker
  // so multiple concurrent tool cards share one interval.
  const [liveElapsed, setLiveElapsed] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!running) {
      startRef.current = null;
      setLiveElapsed(0);
      return;
    }
    // Prefer the server-reported start if present (authoritative: it
    // clocks the actual subprocess launch, not the LLM→executor
    // handoff). Fall back to local Date.now when meta hasn't landed
    // yet so the timer doesn't sit at zero.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `!x` also re-seeds on a 0 timestamp; `??=` would not
    if (!startRef.current) startRef.current = tool.startedAt ?? Date.now();
    const unsub = subscribeTicker(() => {
      setLiveElapsed(Date.now() - (startRef.current ?? Date.now()));
    });
    return unsub;
  }, [running, tool.startedAt]);
  // Remaining time until the executor's timeout fires. Surfaced via
  // tool_progress `meta` event when the bash tool starts. Undefined
  // when meta hasn't landed or the tool has no timeout info.
  // Re-renders every tick because liveElapsed does — no need to
  // separately useState/useEffect for the remaining value.
  const remainingMs =
    tool.timeoutMs != null && running
      ? Math.max(0, tool.timeoutMs - liveElapsed)
      : null;

  return (
    <ToolCardShell
      icon={<TerminalSquare size={13} />}
      title="bash"
      subtitle={
        <span style={{ fontFamily: 'SF Mono, Fira Code, Consolas, monospace' }}>
          {command}
        </span>
      }
      status={tool.status}
      defaultExpanded={running || isDefaultExpanded(tool.name)}
      headerExtras={
        <>
          {exitCode !== null && exitCode !== 0 && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--error)',
                border: '1px solid var(--error)',
                borderRadius: 3,
                padding: '0 4px',
              }}
            >
              exit {exitCode}
            </span>
          )}
          {running && liveElapsed >= 1000 && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--accent)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatDuration(liveElapsed)}
              {remainingMs != null && (
                <span
                  style={{
                    opacity: 0.6,
                    marginLeft: 4,
                    color:
                      remainingMs < 10_000 ? 'var(--error)' : 'var(--muted)',
                  }}
                  title={`Kills in ${formatDuration(remainingMs)}`}
                >
                  / {formatDuration(remainingMs)} left
                </span>
              )}
            </span>
          )}
          {running && tool.status === 'executing' && onStop && (
            <button
              data-id="edit-card-toggle"
              onClick={(e) => {
                e.stopPropagation();
                onStop(tool.id);
              }}
              title="Stop this bash command"
              style={{
                background: 'transparent',
                border: '1px solid var(--error)',
                color: 'var(--error)',
                borderRadius: 3,
                padding: '0 6px',
                fontSize: 10,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                lineHeight: '16px',
              }}
            >
              <Square size={9} fill="currentColor" />
              stop
            </button>
          )}
          {!running && durationMs !== null && durationMs > 0 && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {durationMs < 1000
                ? `${durationMs}ms`
                : `${(durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
        </>
      }
    >
      <div
        style={{
          padding: '8px 10px',
          fontSize: 11,
          fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
          maxHeight: 360,
          overflow: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginBottom: 2,
            fontFamily: 'Inter, sans-serif',
          }}
        >
          <span
            style={{
              color: 'var(--text-muted)',
              fontWeight: 600,
              fontSize: 10,
              textTransform: 'uppercase',
            }}
          >
            Command
          </span>
          <CopyButton text={command} />
        </div>
        <pre
          style={{
            margin: '0 0 8px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--text-secondary)',
          }}
        >
          <LinkifiedText text={command} />
        </pre>
        {filter && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: 2,
              fontFamily: 'Inter, sans-serif',
            }}
          >
            <span
              style={{
                color: 'var(--text-muted)',
                fontWeight: 600,
                fontSize: 10,
                textTransform: 'uppercase',
              }}
            >
              LLM filter
            </span>
            <span
              style={{
                fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
                fontSize: 11,
                color: 'var(--text-muted)',
              }}
            >
              {filter}
            </span>
          </div>
        )}
        {displayOutput && (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 2,
                fontFamily: 'Inter, sans-serif',
              }}
            >
              <span
                style={{
                  color: 'var(--text-muted)',
                  fontWeight: 600,
                  fontSize: 10,
                  textTransform: 'uppercase',
                }}
              >
                {tool.status === 'executing' ? 'Output (live)' : 'Output'}
              </span>
              <CopyButton text={displayOutput} />
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color:
                  tool.status === 'error'
                    ? 'var(--error)'
                    : 'var(--text-secondary)',
              }}
            >
              <ConsoleText
                text={displayOutput}
                errorTone={tool.status === 'error'}
                TextComponent={LinkifiedText}
              />
            </pre>
          </>
        )}
      </div>
    </ToolCardShell>
  );
}

// ── Grep Card ──────────────────────────────────────────────────────

interface GrepHit {
  file: string;
  line: number;
  text: string;
}

/** Parse the grep tool's output. Format:
 *
 *   Found N matches
 *   path/to/file.ts:
 *     Line 42, Char 15: match text
 *     Line 98: function baz() {
 *   path/to/other.go:
 *     Line 5: package main
 */
function parseGrepOutput(
  text: string,
): { hits: GrepHit[]; summary: string } | null {
  if (!text) return null;
  const lines = text.split('\n');
  const hits: GrepHit[] = [];
  let currentFile = '';
  let summary = '';
  for (const line of lines) {
    if (/^Found \d+ match/.test(line)) {
      summary = line.trim();
      continue;
    }
    if (!line.trim()) continue;
    // "path/to/file.ts:" — file header
    const fileMatch = /^(\S.*):$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    // "  Line N[, Char M]: text"
    const hitMatch = /^\s+Line (\d+)(?:, Char \d+)?:\s?(.*)$/.exec(line);
    if (hitMatch && currentFile) {
      hits.push({
        file: currentFile,
        line: parseInt(hitMatch[1], 10),
        text: hitMatch[2],
      });
    }
  }
  if (hits.length === 0) return null;
  return { hits, summary };
}

function DevServerCard({
  tool,
  onStop,
}: {
  tool: ToolUse;
  onStop?: (toolCallId: string) => void;
}) {
  const isStart = isTool(tool.name, 'dev_server_start');
  const input = safeParse(tool.input) ?? {};
  const requestedTimeoutMs: number | undefined =
    typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined;
  const running = tool.status === 'running' || tool.status === 'executing';
  const displayOutput =
    running && tool.liveOutput ? tool.liveOutput : tool.result ?? '';
  // Live elapsed timer + remaining-until-timeout. Same pattern as
  // BashCard so a wedged dev server feels symmetrical with a wedged
  // bash command. Uses a shared 1Hz ticker so it only ticks while a
  // call is actually running.
  const [liveElapsed, setLiveElapsed] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!running) {
      startRef.current = null;
      setLiveElapsed(0);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `!x` also re-seeds on a 0 timestamp; `??=` would not
    if (!startRef.current) startRef.current = tool.startedAt ?? Date.now();
    const unsub = subscribeTicker(() => {
      setLiveElapsed(Date.now() - (startRef.current ?? Date.now()));
    });
    return unsub;
  }, [running, tool.startedAt]);
  const remainingMs =
    tool.timeoutMs != null && running
      ? Math.max(0, tool.timeoutMs - liveElapsed)
      : null;
  return (
    <ToolCardShell
      icon={<Server size={13} />}
      title={tool.name}
      subtitle={
        isStart
          ? requestedTimeoutMs
            ? `start (timeout ${Math.round(requestedTimeoutMs / 1000)}s)`
            : 'start'
          : 'stop'
      }
      status={tool.status}
      defaultExpanded={running || isDefaultExpanded(tool.name)}
      headerExtras={
        <>
          {running && liveElapsed >= 1000 && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--accent)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatDuration(liveElapsed)}
              {remainingMs != null && (
                <span
                  style={{
                    opacity: 0.6,
                    marginLeft: 4,
                    color:
                      remainingMs < 10_000 ? 'var(--error)' : 'var(--muted)',
                  }}
                  title={`Kills in ${formatDuration(remainingMs)}`}
                >
                  / {formatDuration(remainingMs)} left
                </span>
              )}
            </span>
          )}
          {running && tool.status === 'executing' && onStop && (
            <button
              data-id="dev-server-toggle"
              onClick={(e) => {
                e.stopPropagation();
                onStop(tool.id);
              }}
              title={
                isStart
                  ? 'Stop and kill the spawned dev-server process'
                  : 'Abandon the stop request'
              }
              style={{
                background: 'transparent',
                border: '1px solid var(--error)',
                color: 'var(--error)',
                borderRadius: 3,
                padding: '0 6px',
                fontSize: 10,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                lineHeight: '16px',
              }}
            >
              <Square size={9} fill="currentColor" />
              stop
            </button>
          )}
        </>
      }
    >
      <div
        style={{
          padding: '8px 10px',
          fontSize: 11,
          fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
          maxHeight: 360,
          overflow: 'auto',
        }}
      >
        {displayOutput ? (
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-secondary)',
            }}
          >
            <ConsoleText text={displayOutput} TextComponent={LinkifiedText} />
          </pre>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>
            {running ? 'Waiting for dev server output…' : '(no output)'}
          </span>
        )}
      </div>
    </ToolCardShell>
  );
}

function GlobCard({ tool }: { tool: ToolUse }) {
  const cwd = useChatCwd();
  const input = safeParse(tool.input) ?? {};
  const meta = tool.metadata ?? {};
  const pattern: string = input.pattern ?? '';
  const scopePath: string = relativizePath(input.path ?? '', cwd);
  const result = tool.result ?? '';
  // Server returns paths one-per-line, or the literal string
  // 'No matches found' on empty. Use metadata.count when present,
  // otherwise derive from the result body.
  const isEmpty = result === '' || result === 'No matches found';
  const metaCount = typeof meta.count === 'number' ? meta.count : null;
  const truncated = meta.truncated === true;
  const lines = isEmpty
    ? []
    : result
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
  const total = metaCount ?? lines.length;
  return (
    <ToolCardShell
      icon={<Search size={13} />}
      title="glob"
      subtitle={
        <span>
          <code
            style={{
              background: 'var(--bg-primary)',
              padding: '0 3px',
              borderRadius: 3,
            }}
          >
            {pattern}
          </code>
          {scopePath && scopePath !== '.' && <> at {scopePath}</>}
        </span>
      }
      status={tool.status}
      defaultExpanded={isDefaultExpanded(tool.name)}
      headerExtras={
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-muted)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {total} file{total === 1 ? '' : 's'}
          {truncated && ' (truncated)'}
        </span>
      }
    >
      <div
        style={{
          padding: '6px 10px',
          fontSize: 11,
          maxHeight: 360,
          overflow: 'auto',
        }}
      >
        {lines.length === 0 ? (
          <div
            style={{
              color: 'var(--text-muted)',
              fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
            }}
          >
            No matches found
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {lines.map((p, i) => (
              <div
                key={i}
                style={{
                  fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
                  color: 'var(--text-secondary)',
                  wordBreak: 'break-all',
                }}
              >
                <LinkedPath path={p} />
              </div>
            ))}
          </div>
        )}
      </div>
    </ToolCardShell>
  );
}

function GrepCard({ tool }: { tool: ToolUse }) {
  const cwd = useChatCwd();
  const input = safeParse(tool.input) ?? {};
  const meta = (tool.metadata ?? {}) as ToolMetadata;
  const pattern: string = input.pattern ?? '';
  const path: string = relativizePath(input.path ?? '.', cwd);
  const include: string = input.include ?? '';
  const parsed = parseGrepOutput(tool.result ?? '');
  const totalMatches = Number(
    meta.number_of_matches ?? parsed?.hits.length ?? 0,
  );
  const truncated = !!meta.truncated;

  // Group hits by file for compact display.
  const byFile = new Map<string, GrepHit[]>();
  for (const h of parsed?.hits ?? []) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file)!.push(h);
  }

  return (
    <ToolCardShell
      icon={<Search size={13} />}
      title="grep"
      subtitle={
        <span>
          <code
            style={{
              background: 'var(--bg-primary)',
              padding: '0 3px',
              borderRadius: 3,
            }}
          >
            {pattern}
          </code>
          {include && (
            <>
              {' '}
              in{' '}
              <code
                style={{
                  background: 'var(--bg-primary)',
                  padding: '0 3px',
                  borderRadius: 3,
                }}
              >
                {include}
              </code>
            </>
          )}
          {path && path !== '.' && <> at {path}</>}
        </span>
      }
      status={tool.status}
      defaultExpanded={isDefaultExpanded(tool.name)}
      headerExtras={
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-muted)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {totalMatches} match{totalMatches === 1 ? '' : 'es'}
          {truncated && ' (truncated)'}
        </span>
      }
    >
      <div
        style={{
          padding: '6px 10px',
          fontSize: 11,
          maxHeight: 360,
          overflow: 'auto',
        }}
      >
        {parsed && byFile.size > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Array.from(byFile.entries()).map(([file, hits]) => (
              <div key={file}>
                <div
                  style={{
                    color: 'var(--text-primary)',
                    fontWeight: 600,
                    fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
                    fontSize: 11,
                    marginBottom: 2,
                    wordBreak: 'break-all',
                  }}
                >
                  <LinkedPath path={file} />{' '}
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                    · {hits.length}
                  </span>
                </div>
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 1 }}
                >
                  {hits.map((h, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: 8,
                        fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <span
                        style={{
                          color: 'var(--text-muted)',
                          minWidth: 36,
                          textAlign: 'right',
                          flexShrink: 0,
                        }}
                      >
                        <LinkedPath path={file} line={h.line}>
                          {h.line}
                        </LinkedPath>
                      </span>
                      <span
                        style={{
                          whiteSpace: 'pre',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {h.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-secondary)',
              fontFamily: 'SF Mono, Fira Code, Consolas, monospace',
            }}
          >
            {tool.result ? <LinkifiedText text={tool.result} /> : '(no output)'}
          </pre>
        )}
      </div>
    </ToolCardShell>
  );
}

// ── Tool Use Card ───────────────────────────────────────────────────

function ToolUseCard({ tool }: { tool: ToolUse }) {
  const cwd = useChatCwd();
  const subAgentModel =
    tool.metadata && typeof tool.metadata.subAgentModel === 'string'
      ? tool.metadata.subAgentModel
      : null;
  return (
    <ToolCardShell
      icon={getToolIcon(tool.name)}
      title={tool.name}
      subtitle={formatToolInput(tool.name, tool.input, cwd)}
      status={tool.status}
      defaultExpanded={isDefaultExpanded(tool.name)}
    >
      <div style={{ padding: '8px 10px', maxHeight: 360, overflow: 'auto' }}>
        {tool.input && (
          <div
            style={{
              marginBottom:
                tool.result || (tool.children && tool.children.length > 0)
                  ? 10
                  : 0,
            }}
          >
            <ToolInputView tool={tool} />
          </div>
        )}
        {tool.result && (
          <div
            style={{
              marginBottom: tool.children && tool.children.length > 0 ? 10 : 0,
            }}
          >
            <ToolOutputView tool={tool} />
          </div>
        )}
        {subAgentModel && (
          <div style={{ marginBottom: 6 }}>
            <ModelBadge model={subAgentModel} />
          </div>
        )}
        {tool.children && tool.children.length > 0 && (
          <SubagentTree items={tool.children} />
        )}
      </div>
    </ToolCardShell>
  );
}

// ── Permission Card ─────────────────────────────────────────────────

function PermissionCard({
  perm,
  onApprove,
  onApproveAll,
}: {
  perm: PermissionRequest;
  onApprove: () => void;
  onApproveAll: () => void;
}) {
  return (
    <div
      className="us-fade-up"
      style={{
        margin: '6px 16px',
        border: '1px solid var(--accent)',
        borderRadius: 8,
        background: 'rgba(255,85,0,0.05)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <ShieldQuestion
          size={16}
          style={{ color: 'var(--accent)', flexShrink: 0 }}
        />
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            Permission: {perm.toolName}
          </div>
          {perm.description && (
            <div
              style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}
            >
              {perm.description}
            </div>
          )}
          {perm.path && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                fontFamily: 'SF Mono, monospace',
              }}
            >
              {perm.path}
            </div>
          )}
        </div>
      </div>
      <div
        style={{
          borderTop: '1px solid var(--border)',
          padding: '6px 12px',
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
          alignItems: 'center',
        }}
      >
        <span style={{ flex: 1, fontSize: 10, color: 'var(--text-muted)' }}>
          {shortcut('Enter')} allow · {shortcut('Shift', 'Enter')} always allow
          · {shortcut('Shift', 'A')} allow all
        </span>
        <button
          data-id="permission-approve-all"
          onClick={onApproveAll}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '3px 10px',
            fontSize: 11,
            color: 'var(--text-muted)',
            cursor: 'pointer',
          }}
        >
          Always Allow
        </button>
        <button
          data-id="permission-approve"
          onClick={onApprove}
          style={{
            background: 'var(--accent)',
            border: 'none',
            borderRadius: 4,
            padding: '3px 10px',
            fontSize: 11,
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Allow
        </button>
      </div>
    </div>
  );
}

// ── Session readout (cost / tokens) ────────────────────────────────

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function SessionReadout({
  info,
  model,
}: {
  info: import('../hooks/useCodingAgentChat').CodingAgentSessionInfo;
  model: string;
}) {
  // Max-mode parents run no LLM of their own — info.cost / token
  // counters are 0. Fold each peer's spend into a combined view so
  // the chip reflects what the run actually cost. Falls through to
  // info.* unchanged for non-max-mode sessions.
  const peerTotals = info.peerTotals;
  const totalCost = info.cost + (peerTotals?.cost ?? 0);
  const totalPromptTokens = info.promptTokens + (peerTotals?.promptTokens ?? 0);
  const totalCompletionTokens =
    info.completionTokens + (peerTotals?.completionTokens ?? 0);
  const totalCacheReadTokens =
    info.cacheReadTokens + (peerTotals?.cacheReadTokens ?? 0);
  const totalCacheCreationTokens =
    info.cacheCreationTokens + (peerTotals?.cacheCreationTokens ?? 0);
  // Merged per-model array — the parent's own rows plus every peer's,
  // collapsed by model id (cross-peer dupes get summed). Used by the
  // multi-model branch below.
  const combinedPerModel = (() => {
    if (!peerTotals || peerTotals.perModel.length === 0) return info.perModel;
    const merged = new Map<string, (typeof info.perModel)[number]>();
    for (const row of info.perModel) merged.set(row.model, { ...row });
    for (const row of peerTotals.perModel) {
      const existing = merged.get(row.model);
      if (existing) {
        existing.inputTokens += row.inputTokens;
        existing.outputTokens += row.outputTokens;
        existing.cacheReadTokens += row.cacheReadTokens;
        existing.cacheCreationTokens += row.cacheCreationTokens;
        existing.cost += row.cost;
        existing.turnCount += row.turnCount;
      } else {
        merged.set(row.model, { ...row });
      }
    }
    return Array.from(merged.values()).sort((a, b) => b.cost - a.cost);
  })();

  // Always render so the user sees a live $0 / 0-token chip from the
  // moment the session opens. Counters tick up as turns stream in.

  // Auto-mode multi-model branch: when telemetry recorded turns from
  // more than one model, the single-model rate-card lookup against
  // `model` (which collapses to 'auto' in the dropdown) would either
  // miss entirely or compute against the wrong model's rates. Fold the
  // per-turn rate-card costs server-side already wrote into telemetry
  // and surface a per-model breakdown in the tooltip. Chip total is the
  // sum so the visible footprint stays the same. Max-mode parents
  // always have multiple peer models in `combinedPerModel` even though
  // their own perModel is empty — they hit this branch.
  const multiModel = combinedPerModel.length > 1;

  // Pick the model id to feed into the rate card. The displayed `model`
  // prop collapses to 'auto' for auto-mode sessions, which has no entry
  // in STANDARD_MODEL_RATES and would defeat the estimate path. When the
  // session has resolved to a single concrete model (`info.perModel`
  // length 1, or modelMode encoded a concrete pick), use that id
  // instead so subscription users still see a rate-card estimate of
  // what their usage would cost on PAYG.
  const resolvedSingleModel =
    combinedPerModel.length === 1 ? combinedPerModel[0].model : model;

  // Cost chip: prefer the upstream-reported actual cost (framework-billed
  // models populate `info.cost` from ugly.bot's usage frame). When that's
  // zero — either no upstream cost yet, or a subscription provider that
  // never reports per-token cost — fall back to multiplying token
  // counters by the provider's standard published rates so subscription
  // users still see a meaningful number with a "what this would cost
  // on PAYG" caveat in the tooltip.
  const estimate = estimateCost(resolvedSingleModel, {
    inputTokens: totalPromptTokens,
    outputTokens: totalCompletionTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
  });
  const showActual = totalCost > 0;
  const showEstimate = !showActual && estimate !== null && estimate.total > 0;
  const subscriptionCaveat = isSubscriptionProvider(resolvedSingleModel)
    ? "\n\nYou pay this provider via subscription, not per-token — this is what your usage would cost at the upstream's standard pay-as-you-go rates."
    : '';
  // Claude Code recomputes cost from rate cards (so the chip is
  // apples-to-apples with other models) and ALSO carries the CLI's
  // own `total_cost_usd` as `info.billedCost`. Surface the gap in
  // the tooltip so users can see what Anthropic actually charged
  // them vs. the rate-card estimate.
  const billedCaveat =
    model === 'claude-code'
      ? `\n\nAnthropic actually billed: ${
          info.billedCost === undefined
            ? '(not yet reported)'
            : info.billedCost === 0
            ? '$0 (Pro/Team subscription)'
            : formatCurrency(info.billedCost)
        }`
      : '';
  // Caveat appended to every tooltip when the session is a max-mode
  // parent: makes clear the displayed total is summed across the
  // peer fanout (otherwise users see "$X" without context for why
  // the number is much larger than a normal turn).
  const peerCaveat = peerTotals
    ? `\n\nIncludes ${peerTotals.peerCount} max-mode peer session${
        peerTotals.peerCount === 1 ? '' : 's'
      } (this parent ran no LLM of its own).`
    : '';
  const costTitle = showActual
    ? `Actual upstream cost so far: ${formatCurrency(
        totalCost,
      )}${peerCaveat}${billedCaveat}`
    : showEstimate
    ? [
        `Estimated cost at standard rates: ${formatCurrency(estimate.total)}`,
        '',
        `Input  ${formatTokens(totalPromptTokens)}: ${formatCurrency(
          estimate.parts.input,
        )}`,
        `Output ${formatTokens(totalCompletionTokens)}: ${formatCurrency(
          estimate.parts.output,
        )}`,
        totalCacheReadTokens > 0
          ? `Cache read  ${formatTokens(
              totalCacheReadTokens,
            )}: ${formatCurrency(estimate.parts.cacheRead)}`
          : null,
        totalCacheCreationTokens > 0
          ? `Cache write ${formatTokens(
              totalCacheCreationTokens,
            )}: ${formatCurrency(estimate.parts.cacheWrite)}`
          : null,
      ]
        .filter((line) => line !== null)
        .join('\n') +
      subscriptionCaveat +
      peerCaveat +
      billedCaveat
    : '';
  // Cost line folded into the token tooltip so hovering the token chip also
  // shows what the session cost (actual upstream cost when reported, else a
  // rate-card estimate) — requested via feedback.
  const tokenCostLine = showActual
    ? `\nEst. cost so far: ${formatCurrency(totalCost)}`
    : showEstimate
    ? `\nEst. cost: ${formatCurrency(estimate.total)} (standard rates${
        isSubscriptionProvider(resolvedSingleModel) ? '; billed via subscription' : ''
      })`
    : '';
  const tokenTitle = `Input: ${totalPromptTokens.toLocaleString()} tokens · Output: ${totalCompletionTokens.toLocaleString()} tokens${
    totalCacheReadTokens > 0
      ? ` · Cache read: ${totalCacheReadTokens.toLocaleString()}`
      : ''
  }${
    totalCacheCreationTokens > 0
      ? ` · Cache write: ${totalCacheCreationTokens.toLocaleString()}`
      : ''
  }${tokenCostLine}${peerCaveat}`;
  // Multi-model overrides: derive total + tooltip from `perModel` so the
  // chip reflects what actually ran across the session. Rows that
  // logged a non-zero per-turn `cost` (framework-billed) use it
  // verbatim; rows that logged $0 (subscription providers always do —
  // upstream reports no per-token charge) get a rate-card estimate
  // computed at render time so the user still sees what their usage
  // would cost on PAYG. Without this, a multi-model run that mixes
  // any two subscription providers would render `$0.00 · N models`.
  let multiModelTotal = 0;
  let multiModelTitle = '';
  if (multiModel) {
    const lines: string[] = [
      `Estimated cost across ${combinedPerModel.length} models at standard rates:`,
      '',
    ];
    for (const row of combinedPerModel) {
      const rowEstimate =
        row.cost > 0
          ? row.cost
          : estimateCost(row.model, {
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              cacheReadTokens: row.cacheReadTokens,
              cacheCreationTokens: row.cacheCreationTokens,
            })?.total ?? 0;
      multiModelTotal += rowEstimate;
      const tokenSum =
        row.inputTokens +
        row.outputTokens +
        row.cacheReadTokens +
        row.cacheCreationTokens;
      const subCaveat = isSubscriptionProvider(row.model) ? ' (sub)' : '';
      lines.push(
        `${row.model}${subCaveat}  ${formatTokens(
          tokenSum,
        )} tokens · ${formatCurrency(rowEstimate)} · ${row.turnCount} turn${
          row.turnCount === 1 ? '' : 's'
        }`,
      );
    }
    if (combinedPerModel.some((r) => isSubscriptionProvider(r.model))) {
      lines.push(
        '',
        "(sub) = subscription provider — this is what your usage would cost on the upstream's pay-as-you-go rates, not what you actually pay.",
      );
    }
    if (peerCaveat) lines.push(peerCaveat.trimStart());
    multiModelTitle = lines.join('\n');
  }

  return (
    <div className="session-readout">
      <span className="cells" data-us-tooltip={tokenTitle}>
        <span className="cell input">
          <span className="label">↑</span>
          <span>{formatTokens(totalPromptTokens)}</span>
        </span>
        <span className="cell completion">
          <span className="label">↓</span>
          <span>{formatTokens(totalCompletionTokens)}</span>
        </span>
        {totalCacheReadTokens > 0 && (
          <span className="cell cache">
            <span className="label">⚡</span>
            <span>{formatTokens(totalCacheReadTokens)}</span>
          </span>
        )}
        {totalCacheCreationTokens > 0 && (
          <span className="cell cache">
            <span className="label">+</span>
            <span>{formatTokens(totalCacheCreationTokens)}</span>
          </span>
        )}
      </span>
      {multiModel ? (
        <span className="cost-cell" data-us-tooltip={multiModelTitle}>
          ~{formatCurrency(multiModelTotal)}
          <span className="label" style={{ marginLeft: 4, opacity: 0.7 }}>
            · {combinedPerModel.length} models
          </span>
        </span>
      ) : showActual ? (
        <span className="cost-cell" data-us-tooltip={costTitle}>
          {formatCurrency(totalCost)}
        </span>
      ) : showEstimate ? (
        <span className="cost-cell" data-us-tooltip={costTitle}>
          ~{formatCurrency(estimate.total)}
        </span>
      ) : null}
    </div>
  );
}

// ── Context meter (% until compaction, click to compact now) ───────

interface ContextMeterProps {
  info: import('../hooks/useCodingAgentChat').CodingAgentSessionInfo;
  model: string;
  disabled: boolean;
  onClick: () => void;
}

function ContextMeter({ info, model, disabled, onClick }: ContextMeterProps) {
  const budget = info.contextBudget;
  const tokens = info.contextTokens;
  if (budget == null || budget <= 0 || tokens == null) return null;
  const pct = Math.max(0, Math.min(100, Math.round((tokens / budget) * 100)));
  // Color thresholds: muted under 60, warning 60-85, accent/error above.
  const color =
    pct >= 85
      ? 'var(--error, #e24)'
      : pct >= 60
      ? 'var(--warning, #d80)'
      : 'var(--text-muted)';
  const windowLabel = info.contextWindow
    ? ` of ${formatTokens(info.contextWindow)}-token window`
    : '';
  const title = `${tokens.toLocaleString()} / ${budget.toLocaleString()} tokens (${pct}% of compaction budget${windowLabel} for ${model}). Click to compact now — drops middle messages to ~50% of the model window.`;
  return (
    <button
      data-id="tool-shell-header-button"
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-us-tooltip={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 10,
        background: 'var(--bg-secondary, rgba(127,127,127,0.08))',
        border: `1px solid ${color}`,
        color,
        fontSize: 10,
        fontWeight: 500,
        fontVariantNumeric: 'tabular-nums',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'relative',
          width: 28,
          height: 4,
          borderRadius: 2,
          background: 'var(--border, rgba(127,127,127,0.25))',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            position: 'absolute',
            inset: 0,
            right: 'auto',
            width: `${pct}%`,
            background: color,
            transition: 'width 240ms ease-out',
          }}
        />
      </span>
      <span>{pct}%</span>
    </button>
  );
}

// ── Resume banner ──────────────────────────────────────────────────

// Resume banner removed per UX ask — the row below the chat prompt
// previously read "↻ Resumed session '<title>' · N messages · last
// active 3h ago" on every re-entry. It duplicated the session title
// already shown in the top bar + session list, and "Resumed" isn't
// information the user needs past the first second. Component is
// left in place as a null-returner so call sites (e.g. line ~4861
// in this file) keep compiling and the revert is one return swap
// if we ever want it back.
function ResumeBanner(_props: {
  info: import('../hooks/useCodingAgentChat').CodingAgentSessionInfo | null;
}) {
  return null;
}

// ── Markdown rendering ──────────────────────────────────────────────

/**
 * Split content around `<think>...</think>` blocks (some models emit
 * reasoning inline as pseudo-XML instead of using the typed `reasoning`
 * part). Each segment is rendered by the caller: `text` segments get
 * normal markdown, `think` segments get a muted italic reasoning block.
 */
function splitThinkSegments(
  text: string,
): { kind: 'text' | 'think'; body: string }[] {
  const out: { kind: 'text' | 'think'; body: string }[] = [];
  const re = /<think>([\s\S]*?)(?:<\/think>|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last)
      out.push({ kind: 'text', body: text.slice(last, m.index) });
    out.push({ kind: 'think', body: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', body: text.slice(last) });
  return out;
}

function ReasoningBlock({ body }: { body: string }) {
  return (
    <div
      style={{
        margin: '2px 0',
        padding: '0 0 0 8px',
        borderLeft: '2px solid var(--border)',
        color: 'var(--text-muted)',
        fontSize: 12,
        fontStyle: 'italic',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        opacity: 0.85,
      }}
    >
      {body.trim()}
    </div>
  );
}

export { ChatOpenUriProvider };

/**
 * Session cwd for relativizing tool-call paths in card subtitles +
 * result bodies. Set by the chat panel from the active session's
 * snapshot. Consumed by `LinkedPath`, `formatToolInput`, and the
 * tool-card renderers via `useChatCwd()` so they can show
 * `client/foo.tsx` instead of `/Users/.../worktree/client/foo.tsx`.
 * Empty string when no session is active or the snapshot hasn't
 * arrived yet — the helper returns the path unchanged in that case.
 */
const CwdContext = createContext<string>('');

/**
 * Hook for renderers that want the session cwd. Returns '' when no
 * session is active. `relativizePath` already handles the empty-cwd
 * case by returning the input unchanged.
 */
function useChatCwd(): string {
  return useContext(CwdContext);
}

/**
 * Strip the cwd prefix from an absolute path so the chat panel can
 * show the short, portable form. Mirrors
 * `studio/server/coding-agent/tools/path-format.ts` —
 * keep them in sync. Returns the input unchanged when:
 * - cwd is empty (no session yet),
 * - the path doesn't start with cwd,
 * - the path is already relative,
 * - relativizing would produce a `..`-prefixed path that escapes cwd.
 *
 * Always returns forward-slash separators on the output (matches
 * `glob`'s convention and what `path.posix` would produce). The
 * input may contain `\` on Windows — we normalize before comparing.
 */
function relativizePath(p: string, cwd: string): string {
  if (!p || !cwd) return p;
  // Already relative? Leave it.
  if (!p.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(p)) return p;
  const normP = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const normCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normP === normCwd) return '.';
  const prefix = normCwd + '/';
  if (!normP.startsWith(prefix)) return p; // outside cwd; keep absolute
  return normP.slice(prefix.length);
}

// Autolink bare URLs and absolute file paths inside markdown prose, so
// e.g. /Users/admin/foo.md or https://example.com renders clickable
// without the model having to wrap them in [text](url) syntax. Skips
// fenced code blocks, inline code, existing links/images, and HTML/
// autolink angle-bracket tokens so we never mangle code samples or
// links the model already wrote.
const SKIP_TOKEN_RE =
  /(```[\s\S]*?```|`[^`\n]+`|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\s]+>)/g;

// Clickable wrapper around a known file path (used in card subtitles
// and grep file headers). Absolute paths get a `file://` URI; relative
// paths are forwarded as-is so the host can resolve them against the
// project / worktree cwd. Falls back to plain text when no `openUri`
// handler is available.
function LinkedPath({
  path,
  line,
  endLine,
  children,
}: {
  path: string;
  line?: number;
  endLine?: number;
  children?: React.ReactNode;
}): React.ReactElement {
  const openUri = useContext(OpenUriContext);
  const cwd = useChatCwd();
  // Display the cwd-relative form when no explicit children were
  // passed AND the path lives inside cwd. The clickable URI keeps
  // the absolute form so the IDE handler can still open the file.
  const display = children ?? relativizePath(path, cwd);
  if (!openUri) return <>{display}</>;
  const lineSuffix =
    typeof line === 'number' && line > 0
      ? `:${line}${
          typeof endLine === 'number' && endLine > 0 ? `-${endLine}` : ''
        }`
      : '';
  const uri = path.startsWith('/')
    ? `file://${path}${lineSuffix}`
    : `${path}${lineSuffix}`;
  return (
    <a
      data-id="chat-inline-link"
      href={uri}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openUri(uri);
      }}
      style={inlineLinkStyle}
    >
      {display}
    </a>
  );
}

function autolinkChatMarkdown(text: string): string {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(SKIP_TOKEN_RE)) {
    const idx = m.index;
    if (idx > last) out.push(linkifyProse(text.slice(last, idx)));
    out.push(m[0]);
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(linkifyProse(text.slice(last)));
  return out.join('');
}

/** Ugly-app's MarkdownViewer. Needs an explicit pixel width (for image
 *  sizing, table overflow, etc.), so we measure the container. */
function ChatMarkdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const openUri = useContext(OpenUriContext);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(200, e.contentRect.width));
    });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, []);
  const { mode } = useTheme();
  const isDark = mode === 'dark';
  const linked = useMemo(() => autolinkChatMarkdown(text), [text]);
  const handleOpenUri = useMemo(() => {
    if (!openUri) return undefined;
    return (uri: string): Promise<void> => {
      openUri(uri);
      return Promise.resolve();
    };
  }, [openUri]);
  return (
    <div ref={ref} className="us-md" style={{ width: '100%', minWidth: 0 }}>
      {width > 0 && (
        <MdastViewer
          width={width}
          markdown={linked}
          isDark={isDark}
          {...(handleOpenUri ? { openUri: handleOpenUri } : {})}
        />
      )}
    </div>
  );
}

function renderAssistantContent(text: string): React.ReactNode[] {
  const segments = splitThinkSegments(text);
  return segments.map((seg, i) =>
    seg.kind === 'think' ? (
      <ReasoningBlock key={`r${i}`} body={seg.body} />
    ) : (
      <ChatMarkdown key={`t${i}`} text={seg.body} />
    ),
  );
}

// ── Message components ──────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const CRITIQUE_MARKER_CLIENT = '<!-- ugly-studio-reinforce-critique -->';
const TERMINATED_MARKER_CLIENT = '<!-- ugly-studio-reinforce-terminated -->';
const REPLAN_MARKER_CLIENT = '<!-- judge-replan';
const TERMINATE_OPTIONS_RE = /<!-- terminate-options: (\[[\s\S]*?\]) -->/;

function parseCritique(content: string): {
  reason?: string;
  nextAction?: string;
  raw: string;
} {
  const stripped = content.replace(CRITIQUE_MARKER_CLIENT, '').trim();
  const reasonMatch =
    /The previous turn appears incomplete\.\s*([\s\S]*?)(?=\n\s*Do this next:|$)/.exec(
      stripped,
    );
  const nextMatch =
    /Do this next:\s*([\s\S]*?)(?=\n\s*If you genuinely|$)/.exec(stripped);
  return {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty trimmed string must fall back to undefined
    reason: reasonMatch?.[1]?.trim() || undefined,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty trimmed string must fall back to undefined
    nextAction: nextMatch?.[1]?.trim() || undefined,
    raw: stripped,
  };
}

function parseTerminated(content: string): {
  reason?: string;
  raw: string;
  options?: string[];
} {
  // Extract terminate-options marker before stripping other markers
  // so the JSON-in-comment survives replacement.
  let options: string[] | undefined;
  const optMatch = TERMINATE_OPTIONS_RE.exec(content);
  if (optMatch?.[1]) {
    try {
      const parsed: unknown = JSON.parse(optMatch[1]);
      if (
        Array.isArray(parsed) &&
        parsed.every((x): x is string => typeof x === 'string' && x.trim().length > 0)
      ) {
        options = parsed.map((s) => s.trim()).slice(0, 4);
      }
    } catch {
      // ignore malformed payload
    }
  }
  const stripped = content
    .replace(TERMINATED_MARKER_CLIENT, '')
    .replace(TERMINATE_OPTIONS_RE, '')
    .trim();
  const reasonMatch = /Reason:\s*([\s\S]*?)(?=\n\s*Please check|$)/.exec(
    stripped,
  );
  return {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty trimmed string must fall back to undefined
    reason: reasonMatch?.[1]?.trim() || undefined,
    raw: stripped,
    ...(options !== undefined ? { options } : {}),
  };
}

function JudgeNudgeCard({
  msg,
  index,
  total,
}: {
  msg: ChatMessage;
  index: number;
  total: number;
}) {
  const parsed = parseCritique(msg.content);
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty-string reason should not count as a present field
  const hasFields = parsed.reason || parsed.nextAction;
  return (
    <div
      style={{ padding: '4px 16px', display: 'flex', justifyContent: 'center' }}
    >
      <div
        style={{
          maxWidth: '90%',
          padding: '8px 12px',
          borderRadius: 8,
          background: 'rgba(217,119,6,0.08)',
          border: '1px solid rgba(217,119,6,0.4)',
          borderLeft: '3px solid #d97706',
          fontSize: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 4,
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
            color: '#d97706',
          }}
        >
          <AlertCircle size={12} />
          <span>Judge nudge{total > 1 ? ` · ${index}/${total}` : ''}</span>
        </div>
        {hasFields ? (
          <>
            {parsed.reason && (
              <div
                style={{
                  marginBottom: parsed.nextAction ? 4 : 0,
                  color: 'var(--text-secondary)',
                }}
              >
                {parsed.reason}
              </div>
            )}
            {parsed.nextAction && (
              <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>
                  Do next:
                </span>
                {parsed.nextAction}
              </div>
            )}
          </>
        ) : (
          <div
            style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}
          >
            {parsed.raw}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * JudgeCard — collapsed-by-default summary of one judge call. Click to
 * expand into full input + output (system prompt, memory, delta,
 * verdict, intervention details).
 *
 * Renders for every `role: 'judge'` message in the chat stream, regardless
 * of whether the judge fired during the loop (`iter`), at turn end
 * (`post_turn`), or across turns (`session_strategist`).
 *
 * NEVER mistake this for an assistant message — judge messages are
 * server-side filtered out of the agent's LLM context. They exist
 * purely for human inspection.
 */
function JudgeCard({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const j = msg.judge;
  if (!j) return null;
  const v = j.output.verdict;
  const ivKind = j.output.intervention?.kind;
  // Color by verdict — gray for continue, intervention-kind-tinted for
  // intervene. Mirrors the existing JudgeChip colors.
  const tint =
    v === 'continue'
      ? 'var(--text-muted)'
      : ivKind === 'terminate'
      ? 'var(--error)'
      : ivKind === 'replan' || ivKind === 'ask_user'
      ? 'var(--warning, #d68a00)'
      : 'var(--accent, #4a90e2)';
  const summary = `${j.kind} · ${j.model} · ${v}${
    ivKind ? `/${ivKind}` : ''
  } · ${j.latencyMs}ms · ${j.promptTokens + j.completionTokens} tok`;
  return (
    <div style={{ padding: '4px 16px' }}>
      <div
        style={{
          padding: '6px 10px',
          borderRadius: 6,
          border: `1px solid ${tint}`,
          background: 'var(--surface)',
          fontSize: 11,
          fontFamily: 'var(--font-mono, monospace)',
        }}
      >
        <div
          data-id="skill-card-toggle"
          onClick={() => { setExpanded((e) => !e); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            color: tint,
            userSelect: 'none',
          }}
        >
          <span style={{ fontWeight: 700 }}>[judge]</span>
          <span style={{ flex: 1, color: 'var(--text-primary)' }}>
            {summary}
          </span>
          <span
            style={{
              display: 'inline-block',
              transition: 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            ▸
          </span>
        </div>
        <div className="us-collapse" data-open={expanded}>
          <div
            style={{
              marginTop: 8,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
            }}
          >
            <div>
              <div
                style={{
                  fontWeight: 700,
                  marginBottom: 4,
                  color: 'var(--text-muted)',
                }}
              >
                INPUT
              </div>
              <JudgeField label="user request" value={j.input.userRequest} />
              <JudgeField label="hypothesis" value={j.input.hypothesis} />
              <JudgeField label="memory in" value={j.input.memoryIn} />
              <JudgeField label="delta" value={j.input.delta} />
            </div>
            <div>
              <div
                style={{
                  fontWeight: 700,
                  marginBottom: 4,
                  color: 'var(--text-muted)',
                }}
              >
                OUTPUT
              </div>
              <JudgeField label="verdict" value={v} />
              {j.output.intervention && (
                <>
                  <JudgeField
                    label="intervention.kind"
                    value={j.output.intervention.kind}
                  />
                  <JudgeField
                    label="intervention.text"
                    value={j.output.intervention.text}
                  />
                  {j.output.intervention.command && (
                    <JudgeField
                      label="intervention.command"
                      value={j.output.intervention.command}
                    />
                  )}
                </>
              )}
              <JudgeField label="memory out" value={j.output.memoryOut} />
              <JudgeField
                label="hypothesis critique"
                value={j.output.hypothesisCritique}
              />
              {j.output.error && (
                <JudgeField label="error" value={j.output.error} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function JudgeField({ label, value }: { label: string; value?: string }) {
  if (!value || value.trim().length === 0) return null;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{label}</div>
      <pre
        style={{
          margin: 0,
          padding: '4px 6px',
          background: 'var(--bg-secondary, rgba(0,0,0,0.04))',
          borderRadius: 4,
          fontSize: 11,
          maxHeight: 200,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {value.length > 4000 ? value.slice(0, 4000) + '\n…(truncated)' : value}
      </pre>
    </div>
  );
}

/**
 * Live + persisted controls handed to a `DoneCard`. The latest entry
 * (isLatest=true) renders the live finish-pipeline progress / inline
 * modals; older entries render only the persisted historical outcome
 * baked into `msg.done.finishOutcome`.
 */
interface DoneCardControls {
  isLatest: boolean;
  finishPipeline: ReturnType<typeof useCodingAgentChat>['finishPipeline'];
  worktreeParentBranch: string | null;
  showArchivePrompt: boolean;
  dirtyMainPrompt: { files: string[] } | null;
  reviewModal: {
    proposedCommitMessage: string;
    parentBranch: string;
    sessionBranch: string;
    worktreePath: string;
  } | null;
  failurePopup: FinishFailureInfo | null;
  onRunFinish(): void;
  onStopStage(stage: 'tsc' | 'lint' | 'tests'): void;
  onResolveDirtyMain(commit: boolean): void;
  onAcceptReview(commitMessage: string): void;
  onRejectReview(): void;
  onCloseFailure(): void;
  onSkipGate(stage: 'tsc' | 'lint' | 'tests'): void;
  onArchive(): void;
  onDismissArchive(): void;
}

/**
 * "Done entry" card — replaces the toolbar Done button + pinned
 * top-of-chat finish-pipeline progress card. Rendered inline in the
 * virtualized chat list for every `role: 'status'` message.
 *
 * Layout:
 *   - Header: changed-files count + commits-ahead summary.
 *   - Collapsible file list.
 *   - Action row: "Open in git panel" (every entry) + "Done — merge"
 *     (latest entry only, when no finishOutcome yet and no live pipeline).
 *   - Inline finish-pipeline progress (latest entry, when pipeline running/done).
 *   - Inline modal-replacements for dirty-main / awaiting-review /
 *     failure / archive (latest entry, when the relevant state is set).
 *   - Persisted finishOutcome line (any entry whose pipeline already
 *     completed at some point in the past).
 */
function DoneCard({
  msg,
  controls,
}: {
  msg: ChatMessage;
  controls: DoneCardControls;
}) {
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [reviewMessage, setReviewMessage] = useState('');
  const finishPopupRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the inline pipeline output to its latest line, same
  // trick the chat message list uses. Pinned to the bottom whenever
  // any stage's output grows so the user always sees the latest line
  // while a long tsc/lint/tests run streams.
  useEffect(() => {
    const el = finishPopupRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [
    controls.finishPipeline.stages,
    controls.finishPipeline.running,
    controls.finishPipeline.done,
    controls.finishPipeline.message,
  ]);

  // When the awaiting_review modal opens, seed the textarea with the
  // server-derived commit message exactly once. Subsequent edits stay
  // user-owned even if the parent re-renders.
  const seededReviewMessage = controls.reviewModal?.proposedCommitMessage;
  useEffect(() => {
    if (seededReviewMessage !== undefined) {
      setReviewMessage(seededReviewMessage);
    }
  }, [seededReviewMessage]);

  const done = msg.done;
  if (!done) return null;
  const wt = done.worktree;
  const fp = controls.finishPipeline;
  const liveFinishActive = controls.isLatest && (fp.running || fp.done);
  const showFinishButton =
    controls.isLatest &&
    !done.finishOutcome &&
    !fp.running &&
    !fp.done &&
    !controls.dirtyMainPrompt &&
    !controls.reviewModal &&
    !controls.failurePopup &&
    wt.changedCount > 0;

  const summaryLine =
    `${wt.changedCount} file${wt.changedCount === 1 ? '' : 's'} changed` +
    (wt.aheadCount && wt.aheadCount > 0
      ? ` · ${wt.aheadCount} commit${wt.aheadCount === 1 ? '' : 's'} ahead of ${
          wt.parentBranch
        }`
      : '');

  const handleOpenGit = () => {
    window.dispatchEvent(
      new CustomEvent('ugly-studio:open-git-panel', {
        detail: {
          compositeId: done.sessionCompositeId,
          branch: wt.branch,
          parentBranch: wt.parentBranch,
          path: wt.worktreePath,
        },
      }),
    );
  };

  return (
    <div
      data-id="done-entry"
      style={{
        margin: '6px 16px',
        padding: 10,
        border: '1px solid var(--border)',
        borderLeft: '3px solid var(--accent)',
        borderRadius: 4,
        background: 'var(--bg-secondary)',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'var(--font-label)',
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent)',
        }}
      >
        <Check size={12} />
        <span>Done</span>
        <span
          style={{
            flex: 1,
            color: 'var(--text-secondary)',
            fontWeight: 500,
            letterSpacing: 0,
            textTransform: 'none',
          }}
        >
          {summaryLine}
        </span>
      </div>

      {/* Collapsible file list */}
      {wt.changedFiles.length > 0 && (
        <div>
          <div
            data-id="finish-files-toggle"
            onClick={() => { setFilesExpanded((v) => !v); }}
            style={{
              cursor: 'pointer',
              fontSize: 11,
              color: 'var(--text-muted)',
              userSelect: 'none',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                transition: 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
                transform: filesExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                marginRight: 4,
              }}
            >
              ▸
            </span>
            {filesExpanded ? 'Hide' : 'Show'} files ({wt.changedFiles.length})
          </div>
          {filesExpanded && (
            <div
              style={{
                marginTop: 4,
                padding: 6,
                background: 'var(--bg-panel)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                maxHeight: 200,
                overflow: 'auto',
              }}
            >
              {wt.changedFiles.map((f) => (
                <div key={f.path} style={{ display: 'flex', gap: 6 }}>
                  <span
                    style={{
                      width: 14,
                      color:
                        f.status === 'A'
                          ? 'var(--accent)'
                          : f.status === 'D'
                          ? 'var(--error)'
                          : 'var(--text-muted)',
                    }}
                  >
                    {f.status}
                  </span>
                  <span>{f.path}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action row */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          data-id="done-entry-open-git"
          onClick={handleOpenGit}
          style={{
            background: 'transparent',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '5px 12px',
            fontFamily: 'var(--font-label)',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Open in git panel
        </button>
        {showFinishButton && (
          <button
            type="button"
            data-id="done-entry-finish"
            onClick={() => { controls.onRunFinish(); }}
            style={{
              background: 'var(--accent)',
              color: '#fff',
              border: '1px solid var(--accent)',
              borderRadius: 4,
              padding: '5px 14px',
              fontFamily: 'var(--font-label)',
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            Done — merge to {wt.parentBranch}
          </button>
        )}
      </div>

      {/* Inline finish-pipeline progress (latest entry, while running/done). */}
      {liveFinishActive && (
        <div
          ref={finishPopupRef}
          data-id="done-entry-progress"
          style={{
            padding: 8,
            borderRadius: 4,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border)',
            fontSize: 12,
            maxHeight: '40vh',
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 6,
            }}
          >
            <span style={{ fontWeight: 600 }}>
              {fp.running
                ? 'Finishing…'
                : fp.ok
                ? 'Session finished'
                : 'Finish failed'}
            </span>
            {fp.squashSha && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--text-muted)',
                }}
                title={fp.squashSha}
              >
                {fp.squashSha.slice(0, 7)}
              </span>
            )}
          </div>
          {fp.stages.map((s) => (
            <div
              key={s.name}
              data-id={`done-entry-stage-${s.name}`}
              style={{
                marginBottom: 6,
                padding: 6,
                border: '1px solid var(--border)',
                borderRadius: 3,
                background: 'var(--bg-secondary)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {s.name}
                  {s.state === 'running' && ' · running'}
                  {s.state === 'passed' && ' · passed'}
                  {s.state === 'failed' && ` · failed (${s.exitCode ?? ''})`}
                  {s.state === 'stopped' && ' · stopped'}
                  {s.state === 'skipped' &&
                    ` · skipped${s.message ? ` (${s.message})` : ''}`}
                </div>
                {s.state === 'running' &&
                  (s.name === 'tsc' ||
                    s.name === 'lint' ||
                    s.name === 'tests') && (
                    <button
                      data-id="stop-stage"
                      onClick={() =>
                        { controls.onStopStage(s.name as 'tsc' | 'lint' | 'tests'); }
                      }
                      style={{
                        background: 'transparent',
                        border: '1px solid var(--border)',
                        borderRadius: 3,
                        padding: '2px 8px',
                        fontSize: 10,
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      Stop
                    </button>
                  )}
              </div>
              {s.command && (
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    marginTop: 2,
                  }}
                >
                  $ {s.command}
                </div>
              )}
              {s.output && s.output.length > 0 && (
                <pre
                  style={{
                    marginTop: 4,
                    padding: 6,
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 3,
                    maxHeight: 180,
                    overflow: 'auto',
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {s.output.slice(-8000)}
                </pre>
              )}
            </div>
          ))}
          {fp.conflicts && fp.conflicts.length > 0 && (
            <div
              style={{
                padding: 6,
                background: 'rgba(239, 68, 68, 0.12)',
                borderRadius: 3,
                marginTop: 4,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Merge conflicts in {fp.conflictStage}: AI is resolving…
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                }}
              >
                {fp.conflicts.map((f) => (
                  <div key={f}>{f}</div>
                ))}
              </div>
            </div>
          )}
          {fp.message && !fp.ok && (
            <div style={{ color: 'var(--error)', fontSize: 11, marginTop: 4 }}>
              {fp.message}
            </div>
          )}
        </div>
      )}

      {/* Inline dirty-main confirm (latest entry only). */}
      {controls.isLatest && controls.dirtyMainPrompt && (
        <div
          data-id="done-entry-dirty-main"
          style={{
            padding: 8,
            border: '1px solid var(--warning, #d68a00)',
            borderRadius: 4,
            background: 'rgba(214, 138, 0, 0.10)',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            Main repo has uncommitted changes — commit before merging?
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-muted)',
              maxHeight: 120,
              overflow: 'auto',
            }}
          >
            {controls.dirtyMainPrompt.files.map((f) => (
              <div key={f}>{f}</div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              data-id="done-entry-dirty-main-commit"
              onClick={() => { controls.onResolveDirtyMain(true); }}
              style={{
                background: 'var(--accent)',
                color: '#fff',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                padding: '5px 14px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Commit and continue
            </button>
            <button
              data-id="done-entry-dirty-main-cancel"
              onClick={() => { controls.onResolveDirtyMain(false); }}
              style={{
                background: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '5px 14px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Inline awaiting-review (latest entry only). */}
      {controls.isLatest && controls.reviewModal && (
        <div
          data-id="done-entry-review"
          style={{
            padding: 8,
            border: '1px solid var(--accent)',
            borderRadius: 4,
            background: 'var(--bg-panel)',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            Review changes before merging to {controls.reviewModal.parentBranch}
          </div>
          <textarea
            data-id="done-entry-review-message"
            value={reviewMessage}
            onChange={(e) => { setReviewMessage(e.target.value); }}
            rows={4}
            style={{
              width: '100%',
              padding: 6,
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              data-id="done-entry-review-accept"
              onClick={() => { controls.onAcceptReview(reviewMessage); }}
              style={{
                background: 'var(--accent)',
                color: '#fff',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                padding: '5px 14px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Accept &amp; merge
            </button>
            <button
              data-id="done-entry-review-reject"
              onClick={() => { controls.onRejectReview(); }}
              style={{
                background: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '5px 14px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Inline failure popup (latest entry only). */}
      {controls.isLatest && controls.failurePopup && (
        <div
          data-id="done-entry-failure"
          style={{
            padding: 8,
            border: '1px solid var(--error)',
            borderRadius: 4,
            background: 'rgba(239, 68, 68, 0.08)',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            Finish failed at {controls.failurePopup.stage}
            {controls.failurePopup.message
              ? `: ${controls.failurePopup.message}`
              : ''}
          </div>
          {controls.failurePopup.lastStageOutput && (
            <pre
              style={{
                margin: 0,
                padding: 6,
                background: 'var(--bg-primary)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                maxHeight: 180,
                overflow: 'auto',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {controls.failurePopup.lastStageOutput.slice(-4000)}
            </pre>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              data-id="done-entry-failure-retry"
              onClick={() => {
                controls.onCloseFailure();
                controls.onRunFinish();
              }}
              style={{
                background: 'var(--accent)',
                color: '#fff',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                padding: '5px 14px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Retry finish
            </button>
            {(controls.failurePopup.stage === 'tsc' ||
              controls.failurePopup.stage === 'lint' ||
              controls.failurePopup.stage === 'tests') && (
              <button
                data-id="done-entry-failure-skip"
                onClick={() =>
                  { controls.onSkipGate(
                    controls.failurePopup!.stage as 'tsc' | 'lint' | 'tests',
                  ); }
                }
                style={{
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '5px 14px',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                Skip {controls.failurePopup.stage} gate
              </button>
            )}
            <button
              data-id="done-entry-failure-close"
              onClick={() => { controls.onCloseFailure(); }}
              style={{
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '5px 14px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Inline archive prompt (latest entry only, after a successful finish). */}
      {controls.isLatest && controls.showArchivePrompt && fp.done && fp.ok && (
        <div
          data-id="done-entry-archive"
          style={{
            padding: 8,
            background: 'rgba(34, 197, 94, 0.10)',
            border: '1px solid rgba(34, 197, 94, 0.45)',
            borderLeft: '3px solid #22c55e',
            borderRadius: 4,
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontWeight: 600, color: '#22c55e' }}>
            Merged to {wt.parentBranch}
            {fp.squashSha && (
              <>
                {' as '}
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-secondary)',
                    padding: '1px 6px',
                    borderRadius: 3,
                  }}
                  title={fp.squashSha}
                >
                  {fp.squashSha.slice(0, 7)}
                </span>
              </>
            )}
            . Archive this session?
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              data-id="done-entry-archive-confirm"
              onClick={() => { controls.onArchive(); }}
              style={{
                background: 'var(--accent)',
                color: '#fff',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                padding: '5px 14px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Archive session
            </button>
            <button
              data-id="done-entry-archive-dismiss"
              onClick={() => { controls.onDismissArchive(); }}
              style={{
                background: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '5px 14px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {/* Persisted historical outcome — shown on any entry whose
          finish pipeline already completed (success OR failure).
          Hidden only while a NEW pipeline run is actively streaming
          (`fp.running`) so we don't flash a stale receipt next to live
          progress. The fp.done flag stays true after a run, so we
          can't gate on `liveFinishActive` (= isLatest && (running ||
          done)) — that would hide the receipt forever after restart
          when the SessionSnapshot's finishPipeline.done=true is
          re-applied during hydration. */}
      {done.finishOutcome && !fp.running && (
        <div
          data-id="done-entry-outcome"
          style={{
            padding: 6,
            borderRadius: 3,
            background: done.finishOutcome.ok
              ? 'rgba(34, 197, 94, 0.08)'
              : 'rgba(239, 68, 68, 0.08)',
            fontSize: 11,
            color: 'var(--text-secondary)',
          }}
        >
          <div>
            {done.finishOutcome.ok
              ? `Merged to ${wt.parentBranch}`
              : `Finish failed${
                  done.finishOutcome.message
                    ? ` · ${done.finishOutcome.message}`
                    : ''
                }`}
            {done.finishOutcome.squashSha && (
              <>
                {' as '}
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-secondary)',
                    padding: '1px 6px',
                    borderRadius: 3,
                  }}
                  title={done.finishOutcome.squashSha}
                >
                  {done.finishOutcome.squashSha.slice(0, 7)}
                </span>
              </>
            )}
          </div>
          {done.finishOutcome.stages.length > 0 && (
            <div
              style={{
                marginTop: 4,
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-muted)',
              }}
            >
              {done.finishOutcome.stages
                .map((s) => `${s.name}:${s.state}`)
                .join(' · ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JudgeTerminatedCard({
  msg,
  onPickOption,
}: {
  msg: ChatMessage;
  onPickOption?: (text: string) => void;
}) {
  const parsed = parseTerminated(msg.content);
  return (
    <div
      style={{ padding: '6px 16px', display: 'flex', justifyContent: 'center' }}
    >
      <div
        style={{
          maxWidth: '90%',
          padding: '10px 14px',
          borderRadius: 8,
          background: 'rgba(227,18,11,0.1)',
          border: '1px solid var(--error)',
          fontSize: 12,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 6,
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
            color: 'var(--error)',
          }}
        >
          <XCircle size={12} />
          <span>Agent gave up — pick a direction</span>
        </div>
        <div style={{ color: 'var(--text-primary)', marginBottom: 8 }}>
          {/* eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty reason should show the default copy */}
          {parsed.reason || 'Agent was flagged as hopelessly stuck.'}
        </div>
        {parsed.options && parsed.options.length > 0 && onPickOption ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {parsed.options.map((opt, idx) => (
              <button
                data-id="critique-option-pick"
                key={idx}
                type="button"
                onClick={() => { onPickOption(opt); }}
                style={{
                  textAlign: 'left',
                  padding: '7px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                  cursor: 'pointer',
                  lineHeight: 1.4,
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            Check the work above, refine your request, or click stop and start
            fresh.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Render a mid-turn replan message (a synthetic user bubble generated
 * by the harness when the judge picks `replan`). Visually same as a
 * user bubble but with a "↻ harness" badge so it's obvious to the
 * real user that this didn't come from them.
 */
function HarnessReplanBubble({ msg }: { msg: ChatMessage }) {
  // Strip the HTML comment marker from the visible content.
  const stripped = msg.content.replace(/<!-- judge-replan[^>]*-->/, '').trim();
  return (
    <div style={{ padding: '0 16px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 6,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 7px',
            borderRadius: 10,
            background: 'rgba(217,119,6,0.12)',
            border: '1px solid rgba(217,119,6,0.4)',
            fontSize: 10,
            fontWeight: 600,
            color: '#d97706',
            textTransform: 'uppercase',
            letterSpacing: 0.3,
          }}
        >
          ↻ harness
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div
          style={{
            background: 'var(--accent)',
            color: '#fff',
            padding: '8px 14px',
            borderRadius: '14px 14px 4px 14px',
            maxWidth: '85%',
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            opacity: 0.92,
          }}
        >
          {stripped}
        </div>
      </div>
    </div>
  );
}

function UserMessage({ msg }: { msg: ChatMessage }) {
  const attachments = msg.attachments ?? [];
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        padding: '0 16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 6,
          maxWidth: '85%',
        }}
      >
        {attachments.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              justifyContent: 'flex-end',
            }}
          >
            {attachments.map((a, i) => (
              <img
                key={i}
                src={`data:${a.mediaType};base64,${a.base64}`}
                alt={a.filename ?? `attachment-${i}`}
                title={a.filename ?? `attachment-${i}`}
                style={{
                  maxWidth: 200,
                  maxHeight: 160,
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  objectFit: 'cover',
                }}
              />
            ))}
          </div>
        )}
        {msg.content && (
          <div
            style={{
              background: 'var(--accent)',
              color: '#fff',
              padding: '8px 14px',
              borderRadius: '14px 14px 4px 14px',
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {msg.content}
          </div>
        )}
        {msg.created_at != null && msg.created_at > 0 && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              marginTop: 2,
            }}
          >
            {timeAgoShort(msg.created_at)}
          </span>
        )}
      </div>
    </div>
  );
}

// `todos` / `todowrite` are intentionally hidden inline: the agent
// rewrites the full list on every update, which would stack many
// near-duplicate cards through the transcript. Live state is shown by
// the sticky `PinnedTodos` bar; a single final-state snapshot is
// rendered after the turn ends (see `findTurnTodos` below).
const HIDDEN_TOOLS = new Set(['view', 'todos', 'todowrite']);

/**
 * Small pill rendered next to an assistant bubble showing which
 * model produced the response. Useful in `auto` mode where the
 * routing can pick a different model per turn (or a sub-agent
 * may use yet another model). Shortens provider-prefixed ids
 * (`kimi:kimi-k2.6` → `kimi-k2.6`) so the badge fits.
 */
function formatModelLabel(id: string): string {
  if (id.includes(':')) {
    const tail = id.split(':').slice(1).join(':');
    return tail;
  }
  // Clean underscore-id → human-friendly (e.g. claude_sonnet_4_6 → sonnet 4.6).
  return id
    .replace(/^claude_/, '')
    .replace(/^openai_/, '')
    .replace(/_/g, ' ')
    .replace(/\b(\d+)\s(\d+)\b/, '$1.$2');
}

function ModelBadge({ model }: { model: string }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: 'var(--text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 6px',
        borderRadius: 999,
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-subtle, rgba(128,128,128,0.2))',
        opacity: 0.75,
        fontFamily: 'ui-monospace, monospace',
      }}
      title={`Produced by ${model}`}
    >
      {formatModelLabel(model)}
    </div>
  );
}

function AssistantMessage({
  msg,
  checkpointsEnabled,
  onRestoreCheckpoint,
  onStopTool,
}: {
  msg: ChatMessage;
  checkpointsEnabled?: boolean;
  onRestoreCheckpoint?: (msgId: string) => Promise<boolean>;
  onStopTool?: (toolCallId: string) => void;
  sessionIsStreaming?: boolean;
}) {
  const [restoreState, setRestoreState] = useState<
    'idle' | 'confirming' | 'working' | 'done' | 'failed'
  >('idle');
  const hasBubbleContent = !!msg.content;
  const visibleTools = msg.toolUses.filter(
    (t) => !HIDDEN_TOOLS.has(t.name.toLowerCase()),
  );

  const handleRestoreClick = async () => {
    if (!onRestoreCheckpoint) return;
    if (restoreState === 'idle') {
      setRestoreState('confirming');
      return;
    }
    if (restoreState === 'confirming') {
      setRestoreState('working');
      const ok = await onRestoreCheckpoint(msg.id);
      setRestoreState(ok ? 'done' : 'failed');
      setTimeout(() => { setRestoreState('idle'); }, 3000);
    }
  };

  if (!hasBubbleContent && visibleTools.length === 0) return null;

  return (
    <div
      style={{
        padding: '0 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
      className="us-assistant-msg"
    >
      {hasBubbleContent && (
        <div
          style={{
            background: 'var(--bg-secondary)',
            padding: '10px 14px',
            borderRadius: '14px 14px 14px 4px',
            maxWidth: '95%',
            fontSize: 13,
            lineHeight: 1.6,
            color: 'var(--text-primary)',
            position: 'relative',
          }}
        >
          {msg.content && <div>{renderAssistantContent(msg.content)}</div>}
          {msg.created_at != null && msg.created_at > 0 && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-muted)',
                display: 'block',
                marginTop: 4,
              }}
            >
              {timeAgoShort(msg.created_at)}
            </span>
          )}
          {/* eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean render guard: empty model string should not force the footer */}
          {(msg.model || (checkpointsEnabled && onRestoreCheckpoint)) && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                marginTop: 8,
              }}
            >
              {checkpointsEnabled && onRestoreCheckpoint ? (
                <RestoreCheckpointAction
                  data-id="restore-checkpoint-action"
                  state={restoreState}
                  onClick={() => void handleRestoreClick()}
                  onCancel={() => { setRestoreState('idle'); }}
                />
              ) : (
                <span />
              )}
              {msg.model && <ModelBadge model={msg.model} />}
            </div>
          )}
        </div>
      )}

      {visibleTools.map((tool) => {
        const lower = tool.name.toLowerCase();
        if (lower === 'think') {
          return <ThinkCard key={tool.id} tool={tool} />;
        }
        if (isTool(lower, 'edit') || isTool(lower, 'write') || isTool(lower, 'multiedit')) {
          return <EditCard key={tool.id} tool={tool} />;
        }
        if (isTool(lower, 'bash')) {
          return (
            <BashCard
              key={tool.id}
              tool={tool}
              {...(onStopTool ? { onStop: onStopTool } : {})}
            />
          );
        }
        if (isTool(lower, 'dev_server_start') || isTool(lower, 'dev_server_stop')) {
          return (
            <DevServerCard
              key={tool.id}
              tool={tool}
              {...(onStopTool ? { onStop: onStopTool } : {})}
            />
          );
        }
        if (lower === 'grep') {
          return <GrepCard key={tool.id} tool={tool} />;
        }
        if (lower === 'glob') {
          return <GlobCard key={tool.id} tool={tool} />;
        }
        return <ToolUseCard key={tool.id} tool={tool} />;
      })}
    </div>
  );
}

/**
 * Phase 4 — small hover/click action surfaced on each assistant
 * bubble when shadow-git checkpoints are enabled. First click arms
 * the confirm state (to prevent accidental rollbacks), second click
 * fires the RPC. Shows a brief success/failure badge then resets.
 */
function RestoreCheckpointAction({
  state,
  onClick,
  onCancel,
}: {
  state: 'idle' | 'confirming' | 'working' | 'done' | 'failed';
  onClick: () => void;
  onCancel: () => void;
}) {
  const label =
    state === 'confirming'
      ? 'Click again to restore'
      : state === 'working'
      ? 'Restoring…'
      : state === 'done'
      ? 'Restored ✓'
      : state === 'failed'
      ? 'Restore failed'
      : 'Restore to this checkpoint';
  const color =
    state === 'confirming'
      ? 'var(--warning, #d97706)'
      : state === 'done'
      ? 'var(--success, #1eb45a)'
      : state === 'failed'
      ? 'var(--error, #e3120b)'
      : 'var(--text-muted)';
  return (
    <div
      className="us-restore-action"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 10,
      }}
    >
      <button
        data-id="restore-confirm"
        onClick={onClick}
        disabled={state === 'working' || state === 'done'}
        style={{
          background: 'transparent',
          border: `1px solid ${color}`,
          color,
          borderRadius: 4,
          padding: '2px 8px',
          fontSize: 10,
          cursor:
            state === 'working' || state === 'done' ? 'default' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <RotateCcw size={10} />
        {label}
      </button>
      {state === 'confirming' && (
        <button
          data-id="restore-cancel"
          onClick={onCancel}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 10,
            padding: '2px 4px',
          }}
        >
          cancel
        </button>
      )}
    </div>
  );
}

/**
 * Inline card rendered when the agent calls `ask_user` and the
 * server broker is awaiting a response. Shows the question, the
 * header (optional), up to 4 option chips, and an "Other…" text
 * input. Clicking a chip or submitting "Other" routes the answer
 * back through the hook's `answerAskUser` RPC, which resolves the
 * tool's awaited promise server-side and lets the turn continue.
 */
function AskUserCard({
  pending,
  onAnswer,
  peerLabel,
  queueDepth,
}: {
  pending: PendingAskUser;
  onAnswer: (
    toolCallId: string,
    value: string,
    targetSessionId?: string,
  ) => Promise<boolean>;
  /**
   * When the question came from a max-mode peer (not the active
   * session), render a small "Peer · <model id>" chip so the user
   * knows which session is asking. Undefined for parent-source
   * questions; the card is unlabeled in that case.
   */
  peerLabel?: string;
  /**
   * Total number of pending questions in the queue (including this
   * one). Used to render a `+N more pending` hint below the card so
   * the user knows there's a follow-up after they answer this one.
   */
  queueDepth?: number;
}) {
  const [otherText, setOtherText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(
    async (value: string) => {
      if (submitting || !value.trim()) return;
      setSubmitting(true);
      // Route the answer to the originating session's broker — for
      // peer cards in a max-mode parent's queue, that's the peer
      // compositeId, not the active session.
      await onAnswer(pending.toolCallId, value, pending.sessionId);
      // Local state clears via the hook's optimistic update or the
      // ask_user_resolved event; this component unmounts either way.
    },
    [pending.toolCallId, pending.sessionId, onAnswer, submitting],
  );

  return (
    <div
      style={{
        margin: '8px 16px',
        padding: '12px 14px',
        borderRadius: 8,
        background: 'rgba(94,123,255,0.08)',
        border: '1px solid rgba(94,123,255,0.4)',
        borderLeft: '3px solid var(--accent, #5e7bff)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color: 'var(--accent, #5e7bff)',
          marginBottom: 6,
        }}
      >
        <ShieldQuestion size={12} />
        <span>
          Agent needs your input
          {pending.header ? ` — ${pending.header}` : ''}
        </span>
        {peerLabel && (
          <span
            style={{
              padding: '1px 6px',
              borderRadius: 8,
              background: 'rgba(94,123,255,0.16)',
              border: '1px solid rgba(94,123,255,0.4)',
              fontSize: 9,
              letterSpacing: 0.3,
            }}
            title={`Question raised by peer session ${peerLabel}`}
          >
            Peer · {peerLabel}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          marginBottom: 10,
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {pending.question}
      </div>
      {pending.options.length > 0 && (
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}
        >
          {pending.options.map((opt, i) => (
            <button
              data-id="ask-user-option"
              key={i}
              onClick={() => {
                void submit(opt.label);
              }}
              disabled={submitting}
              title={opt.description || undefined}
              style={{
                padding: '6px 12px',
                borderRadius: 16,
                border: '1px solid var(--border)',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                fontSize: 12,
                cursor: submitting ? 'default' : 'pointer',
                opacity: submitting ? 0.5 : 1,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          data-id="ask-user-other-input"
          type="text"
          placeholder="Other…"
          value={otherText}
          onChange={(e) => { setOtherText(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && otherText.trim() && !submitting) {
              void submit(`Other: ${otherText.trim()}`);
            }
          }}
          disabled={submitting}
          style={{
            flex: 1,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            fontSize: 12,
          }}
        />
        <button
          data-id="ask-user-submit"
          onClick={() => {
            if (otherText.trim() && !submitting) {
              void submit(`Other: ${otherText.trim()}`);
            }
          }}
          disabled={submitting || !otherText.trim()}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid var(--accent, #5e7bff)',
            background: 'var(--accent, #5e7bff)',
            color: '#fff',
            fontSize: 12,
            cursor: submitting || !otherText.trim() ? 'default' : 'pointer',
            opacity: submitting || !otherText.trim() ? 0.5 : 1,
          }}
        >
          {submitting ? 'Sending…' : 'Send'}
        </button>
      </div>
      {queueDepth !== undefined && queueDepth > 1 && (
        <div
          style={{
            marginTop: 8,
            fontSize: 10,
            color: 'var(--text-muted)',
            letterSpacing: 0.2,
          }}
        >
          +{queueDepth - 1} more pending — answer this one to see the next.
        </div>
      )}
    </div>
  );
}

/**
 * Step-review card. Renders between SPEC and BUILD (or DIAGNOSE and
 * FIX) when the pattern driver pauses for user approval. The spec /
 * diagnosis itself is shown in its existing tab — this card is just
 * the approve/iterate strip.
 */
function StepReviewCard({
  pending,
  onAnswer,
}: {
  pending: PendingStepReview;
  onAnswer: (
    id: string,
    action: 'continue' | 'iterate',
    feedback?: string,
    targetSessionId?: string,
  ) => Promise<boolean>;
}) {
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(
    async (action: 'continue' | 'iterate') => {
      if (submitting) return;
      if (action === 'iterate' && !feedback.trim()) return;
      setSubmitting(true);
      await onAnswer(
        pending.id,
        action,
        action === 'iterate' ? feedback.trim() : undefined,
        pending.sessionId,
      );
      // Component unmounts via the snapshot's `pendingStepReviews`
      // shrinking, or via the hook's optimistic clear. No local reset.
    },
    [pending.id, pending.sessionId, feedback, onAnswer, submitting],
  );

  const stepNoun = pending.stepLabel.toLowerCase();

  return (
    <div
      data-id="step-review-card"
      data-step-id={pending.stepId}
      data-pending-id={pending.id}
      style={{
        margin: '8px 16px',
        padding: '12px 14px',
        borderRadius: 8,
        background: 'rgba(86,182,131,0.08)',
        border: '1px solid rgba(86,182,131,0.4)',
        borderLeft: '3px solid var(--success, #56b683)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color: 'var(--success, #56b683)',
          marginBottom: 6,
        }}
      >
        <FileText size={12} />
        <span>{pending.stepLabel} ready for review</span>
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          marginBottom: 10,
          color: 'var(--text-primary)',
        }}
      >
        Approve to continue to the next step, or send feedback to iterate on the{' '}
        {stepNoun}.
      </div>
      <textarea
        data-id="step-review-feedback"
        value={feedback}
        onChange={(e) => { setFeedback(e.target.value); }}
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' &&
            (e.metaKey || e.ctrlKey) &&
            feedback.trim() &&
            !submitting
          ) {
            void submit('iterate');
          }
        }}
        disabled={submitting}
        placeholder={`Feedback on the ${stepNoun}…`}
        rows={3}
        style={{
          width: '100%',
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          fontSize: 12,
          fontFamily: 'inherit',
          resize: 'vertical',
          marginBottom: 8,
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          data-id="step-review-iterate"
          onClick={() => {
            if (feedback.trim() && !submitting) void submit('iterate');
          }}
          disabled={submitting || !feedback.trim()}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            fontSize: 12,
            cursor: submitting || !feedback.trim() ? 'default' : 'pointer',
            opacity: submitting || !feedback.trim() ? 0.5 : 1,
          }}
          title={`Re-run this step with your feedback (${shortcut(
            'Enter',
          )} in textarea)`}
        >
          Send feedback & iterate
        </button>
        <button
          data-id="step-review-approve"
          onClick={() => {
            if (!submitting) void submit('continue');
          }}
          disabled={submitting}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid var(--success, #56b683)',
            background: 'var(--success, #56b683)',
            color: '#fff',
            fontSize: 12,
            cursor: submitting ? 'default' : 'pointer',
            opacity: submitting ? 0.5 : 1,
          }}
        >
          {submitting ? 'Working…' : 'Approve & continue'}
        </button>
      </div>
    </div>
  );
}

// ── Reinforce toggle ────────────────────────────────────────────────
//
// Per-project opt-in for ReAct preamble + Reflexion self-critique +
// auto plan mode. Only shown when the active model is classified
// `reasoning: 'weak'` in ModelSelector.tsx — strong models don't need
// the extra prompting and the toggle is noise. See
// server/coding-agent/reinforcement/ for what this actually does.

// ── Subagent (delegate) tree renderer ───────────────────────────────

/**
 * Render the live state of a delegate child inside its parent
 * tool use. Children are stacked in spawn order and indent one
 * level per nesting depth. Each child shows its in-flight tool
 * calls (recursively, so a child's `delegate` call shows ITS
 * children) and the latest assistant text.
 */
function SubagentTree({ items }: { items: SubagentChild[] }) {
  if (items.length === 0) return null;
  return (
    <div
      style={{
        borderTop: '1px dashed var(--border)',
        marginTop: 6,
        paddingTop: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontFamily: 'Inter, sans-serif',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          fontWeight: 600,
          marginBottom: 2,
        }}
      >
        Delegated children ({items.length})
      </div>
      {items.map((child) => (
        <SubagentChildCard key={child.sessionId} child={child} />
      ))}
    </div>
  );
}

function SubagentChildCard({ child }: { child: SubagentChild }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div
      style={{
        marginLeft: 6,
        borderLeft: `2px solid ${
          child.isStreaming ? 'var(--accent)' : 'var(--border)'
        }`,
        paddingLeft: 8,
        transition: 'border-color 0.15s',
      }}
    >
      <div
        data-id="subagent-toggle"
        onClick={() => { setExpanded((v) => !v); }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          userSelect: 'none',
          padding: '2px 0',
        }}
      >
        <GitBranch size={11} style={{ color: 'var(--text-muted)' }} />
        <span style={{ fontWeight: 600 }}>child {child.index}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
          depth {child.depth}
        </span>
        {child.isStreaming ? (
          <Loader2
            size={10}
            className="us-spin"
            style={{ color: 'var(--accent)' }}
          />
        ) : (
          <Check size={10} style={{ color: 'var(--success)' }} />
        )}
        <span style={{ flex: 1 }} />
        {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </div>
      <div className="us-collapse" data-open={expanded}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            paddingTop: 4,
            paddingBottom: 4,
          }}
        >
          {child.toolUses.map((tu) => (
            <ToolUseCard key={tu.id} tool={tu} />
          ))}
          {child.text && (
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.4,
                color: 'var(--text-secondary)',
                padding: '4px 6px',
                background: 'var(--bg-secondary)',
                borderRadius: 4,
                fontFamily: 'Inter, sans-serif',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {child.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Auto-mode route hint (header chip) ──────────────────────────────

interface AutoRouteHintProps {
  routing: {
    source:
      | 'manual'
      | 'auto-classified'
      | 'auto-default'
      | 'expensive-parallel';
    modelId: string;
    reason?: string;
    profileSummary?: string;
    nudgeClaimer?: string;
    parallelBranches?: string[];
    at: number;
  } | null;
}

/**
 * Inline chip showing WHY the auto router picked the current model.
 * Reads `auto_mode_routing` events emitted by the server (Phase 0.5
 * of the auto-mode tournament). Only renders when the router actually
 * fired or when an unusual mode (expensive-parallel) is in play —
 * manual single-model turns don't display anything.
 *
 * The chip is intentionally compact — full routing data lives in the
 * tooltip so hovering surfaces the profile / allowlist / branch list
 * without cluttering the header on the average turn.
 */
function AutoRouteHint({ routing }: AutoRouteHintProps) {
  if (!routing) return null;
  if (routing.source === 'manual') return null;
  const isParallel = routing.source === 'expensive-parallel';
  const label = isParallel
    ? `parallel: ${routing.parallelBranches?.length ?? 0} branches`
    : routing.reason ?? `auto: → ${routing.modelId}`;
  const tooltipParts: string[] = [];
  if (routing.profileSummary) {
    tooltipParts.push(`profile: ${routing.profileSummary}`);
  }
  if (routing.parallelBranches?.length) {
    tooltipParts.push(`branches: ${routing.parallelBranches.join(', ')}`);
  }
  if (routing.nudgeClaimer) {
    tooltipParts.push(`nudge: ${routing.nudgeClaimer}`);
  }
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty join / empty reason must fall back to the next value
  const tooltip = tooltipParts.join(' · ') || routing.reason || routing.modelId;
  return (
    <div
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginLeft: 8,
        padding: '2px 8px',
        fontSize: 10,
        fontWeight: 500,
        lineHeight: 1.4,
        color: isParallel ? 'var(--accent)' : 'var(--text-secondary)',
        background: isParallel
          ? 'rgba(96, 165, 250, 0.10)'
          : 'var(--bg-secondary)',
        border: `1px solid ${
          isParallel ? 'rgba(96, 165, 250, 0.35)' : 'var(--border)'
        }`,
        borderRadius: 10,
        fontFamily: 'var(--font-mono)',
        whiteSpace: 'nowrap',
        maxWidth: 320,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: 'help',
      }}
    >
      {label}
    </div>
  );
}

// ── Max-mode peer pill switcher ─────────────────────────────────────

export interface PeerSessionRef {
  compositeId: string;
  /** Display model id (e.g. `kimi:kimi-k2.6`). */
  model: string;
  /** True while the peer's turn loop is mid-flight. Drives the dim. */
  running: boolean;
}

interface MaxModePeerPillsProps {
  peers: PeerSessionRef[];
  /** When set, the matching peer pill renders with the success-green
   *  highlight — the picker selected this peer at the end of the most
   *  recent max-mode turn. */
  winnerCompositeId?: string;
  /**
   * Per-peer stuck-watchdog state, keyed by peer model id. When
   * present for a given peer, the pill renders with an amber border
   * + an inline "stuck Nm" suffix so the user can see a silent
   * provider hang at a glance.
   */
  peerStuckState?: Record<string, { stuckMs: number; updatedAt: number }>;
  /** Click handler; receives the peer's compositeId so the host can
   *  navigate to that session via the same `onSelectSession` machinery
   *  the sidebar uses. */
  onSelectPeer?: (peerCompositeId: string) => void;
}

/**
 * Pill row that appears above the chat transcript when the parent
 * session has max-mode peers. Each pill is a quick-access shortcut
 * to navigate to that peer's session (peers are first-class
 * sessions with `parentSessionId` set; the sidebar shows them
 * indented under the parent — pills are the same navigation, just
 * inline).
 *
 * `peers` come from `SessionLayout.peerSessions` (filtered from the
 * sessions list on `parentSessionId === active.compositeId`).
 */
function MaxModePeerPills({
  peers,
  winnerCompositeId,
  peerStuckState,
  onSelectPeer,
}: MaxModePeerPillsProps) {
  if (peers.length === 0) return null;
  const pillBase: React.CSSProperties = {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '3px 10px',
    fontSize: 11,
    color: 'var(--text-muted)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    fontFamily: 'var(--font-label, inherit)',
  };
  // Stable alphabetical order so live status flips don't reshuffle pills.
  const sorted = [...peers].sort((a, b) => a.model.localeCompare(b.model));
  return (
    <div
      data-id="max-mode-peer-pills"
      style={{
        display: 'flex',
        gap: 6,
        padding: '6px 12px',
        borderBottom: '1px solid var(--border)',
        background: 'color-mix(in srgb, var(--bg-secondary) 30%, transparent)',
        overflowX: 'auto',
        alignItems: 'center',
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 700,
          marginRight: 4,
        }}
      >
        Peers
      </span>
      {sorted.map((p) => {
        const isWinner = winnerCompositeId === p.compositeId;
        const stuck = peerStuckState?.[p.model];
        const stuckMin = stuck
          ? Math.max(1, Math.round(stuck.stuckMs / 60_000))
          : 0;
        const status = isWinner
          ? 'winner'
          : stuck
          ? `stuck ~${stuckMin}m`
          : p.running
          ? 'running'
          : 'idle';
        const amber = 'var(--warning, #d97706)';
        return (
          <button
            key={p.compositeId}
            onClick={() => onSelectPeer?.(p.compositeId)}
            title={`${p.model} · ${status} — open peer session${
              stuck
                ? `\n\nNo events received for ~${stuckMin} min. The runner has not auto-aborted; click to inspect or use Stop on the parent to cancel.`
                : ''
            }`}
            style={{
              ...pillBase,
              opacity: p.running || isWinner || stuck ? 1 : 0.6,
              ...(isWinner && {
                borderColor: 'var(--success, #4caf50)',
                color: 'var(--success, #4caf50)',
              }),
              ...(stuck &&
                !isWinner && {
                  borderColor: amber,
                  color: amber,
                }),
            }}
            data-id={`peer-pill-${p.model}`}
          >
            {p.model}
            {stuck && !isWinner && (
              <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.85 }}>
                ⚠ {stuckMin}m
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Per-peer live status strip ──────────────────────────────────────

interface PeerLiveStripProps {
  peers: PeerSessionRef[];
  peerToolProgress: Record<string, PeerToolProgress>;
  peerLspState: Record<string, PeerLspState>;
  /**
   * Per-peer stuck state from the runner's watchdog. Renders an amber
   * "⚠ stuck Nm" chip alongside the peer's model name when the peer
   * hasn't fired any event for >120s. Cleared the moment any fresh
   * peer_event lands. Undefined when no peer is currently stuck.
   */
  peerStuckState?: Record<string, { stuckMs: number; updatedAt: number }>;
}

/**
 * Compact per-peer "currently running" + LSP-error chips strip,
 * shown above the parent's interleaved transcript when peers are
 * live. Each chip renders the peer's model, the tail of its
 * latest `tool_progress` chunk (if recent), and red/yellow LSP
 * counts. The actual peer message stream is interleaved into the
 * main virtualizer (see `displayMessages` in the parent), so this
 * strip is purely real-time status.
 */
function PeerLiveStrip({
  peers,
  peerToolProgress,
  peerLspState,
  peerStuckState,
}: PeerLiveStripProps) {
  if (peers.length === 0) return null;
  const chips = peers.map((p) => {
    const tp = peerToolProgress[p.model];
    const lsp = peerLspState[p.model];
    const stuck = peerStuckState?.[p.model];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- record index access can be undefined at runtime (noUncheckedIndexedAccess is off)
    const live = tp && Date.now() - tp.updatedAt < 10_000 ? tp : null;
    const liveSnippet = live
      ? (
          live.text
            .split('\n')
            .filter((l) => l.trim())
            .pop() ?? ''
        ).slice(-120)
      : '';
    return {
      peer: p,
      live,
      liveSnippet,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- record index access can be undefined at runtime (noUncheckedIndexedAccess is off)
      errCount: lsp?.totalErrors ?? 0,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- record index access can be undefined at runtime (noUncheckedIndexedAccess is off)
      warnCount: lsp?.totalWarnings ?? 0,
      stuckMs: stuck?.stuckMs ?? 0,
    };
  });
  const hasContent = chips.some(
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR over predicates, not a nullish fallback
    (c) => c.live || c.errCount > 0 || c.warnCount > 0 || c.stuckMs > 0,
  );
  if (!hasContent) return null;
  return (
    <div
      data-id="peer-live-strip"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        padding: '4px 12px',
        fontSize: 11,
        borderBottom: '1px solid var(--border)',
        background: 'color-mix(in srgb, var(--bg-secondary) 25%, transparent)',
      }}
    >
      {chips.map(
        ({ peer, live, liveSnippet, errCount, warnCount, stuckMs }) => {
          const stuckMin =
            stuckMs > 0 ? Math.max(1, Math.round(stuckMs / 60_000)) : 0;
          return (
            <div
              key={peer.compositeId}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                background: 'var(--bg-secondary)',
                border:
                  stuckMs > 0
                    ? '1px solid var(--warning, #d97706)'
                    : '1px solid var(--border)',
                borderRadius: 10,
                fontSize: 10.5,
                whiteSpace: 'nowrap',
                maxWidth: 360,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={
                stuckMs > 0
                  ? `${peer.model} · stuck ~${stuckMin}m\n\nNo events received from this peer for ${stuckMin} min — likely a provider hang, rate-limit cascade, or parser failure. The runner has not auto-aborted; use Stop on the parent to cancel.`
                  : live
                  ? `${peer.model} · live ${live.stream}`
                  : peer.model
              }
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  color:
                    stuckMs > 0 ? 'var(--warning, #d97706)' : 'var(--accent)',
                }}
              >
                {peer.model}
              </span>
              {stuckMs > 0 && (
                <span
                  style={{
                    color: 'var(--warning, #d97706)',
                    fontWeight: 700,
                  }}
                >
                  ⚠ stuck {stuckMin}m
                </span>
              )}
              {live && stuckMs === 0 && (
                <span
                  style={{
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 220,
                  }}
                >
                  ▸ {liveSnippet || `(${live.stream})`}
                </span>
              )}
              {errCount > 0 && (
                <span
                  style={{ color: 'var(--error, #e3120b)', fontWeight: 700 }}
                  title="LSP errors in this peer's worktree"
                >
                  ✗{errCount}
                </span>
              )}
              {warnCount > 0 && (
                <span
                  style={{ color: 'var(--warning, #ff9800)', fontWeight: 600 }}
                  title="LSP warnings in this peer's worktree"
                >
                  ⚠{warnCount}
                </span>
              )}
            </div>
          );
        },
      )}
    </div>
  );
}

// ── Codebase readiness pill (header status) ───────────────────────

/**
 * Compact dot + short label rendered in the panel header next to
 * ContextMeter. Surfaces architecture + semantic-index readiness in
 * one chip; hover the chip to see the full per-surface status via
 * the `title` tooltip. Replaced the wide `CodebaseAnalysisStrip`
 * that used to live inside the input area — the header is the right
 * home because readiness is a session-level signal, not an
 * input-area concern.
 */
function CodebaseReadinessPill({
  readiness,
  onOpenStats,
}: {
  readiness:
    | import('../shared/api').SessionSnapshot['codebaseReadiness']
    | null;
  /** Open the detailed stats modal. */
  onOpenStats: () => void;
}) {
  const arch = readiness?.architecture;
  const indexer = readiness?.indexer;
  const archActive = arch?.status === 'building';
  const idxActive = indexer?.status === 'indexing';
  const archReady = arch?.status === 'ready';
  const idxReady = indexer?.status === 'ready';
  const anyActive = archActive || idxActive;
  const anyError = arch?.status === 'failed' || indexer?.status === 'error';

  // In a plain browser there's no host to run the indexer, so `codebase.status`
  // never reports and the pill would spin "loading…" forever. Show it's the host
  // that's missing, not an in-progress analysis.
  const nativeMissing = !isNativeAvailable();
  // null = the client agent hasn't reported yet (poll spinning up the host indexer).
  let tone: 'loading' | 'active' | 'ready' | 'idle' | 'error';
  if (nativeMissing) tone = 'idle';
  else if (!readiness) tone = 'loading';
  else if (anyError) tone = 'error';
  else if (anyActive) tone = 'active';
  else if (archReady && idxReady) tone = 'ready';
  else tone = 'idle';

  const dotColor = {
    loading: '#888',
    active: '#f0a000',
    ready: '#4caf50',
    idle: '#888',
    error: '#e53935',
  }[tone];
  const pulse = tone === 'active';

  const archLabel = (() => {
    if (!arch) return 'Architecture: …';
    if (arch.status === 'building') {
      return arch.filesAnalyzed != null && arch.filesTotal
        ? `Architecture: building (${arch.filesAnalyzed}/${arch.filesTotal})`
        : 'Architecture: building';
    }
    if (arch.status === 'ready') return 'Architecture: ready';
    if (arch.status === 'failed') return 'Architecture: failed';
    return 'Architecture: not started';
  })();
  const idxLabel = (() => {
    if (!indexer) return 'Semantic index: …';
    if (indexer.status === 'indexing') {
      if (indexer.indexedChunks != null && indexer.totalChunks) {
        const pct = Math.floor(
          (indexer.indexedChunks / indexer.totalChunks) * 100,
        );
        return `Semantic index: ${pct}% (${indexer.indexedChunks}/${indexer.totalChunks})`;
      }
      return 'Semantic index: starting';
    }
    if (indexer.status === 'ready') {
      return indexer.totalChunks
        ? `Semantic index: ready (${indexer.totalChunks} chunks)`
        : 'Semantic index: ready';
    }
    if (indexer.status === 'error') return 'Semantic index: error';
    return 'Semantic index: not indexed';
  })();
  const shortLabel =
    nativeMissing
      ? 'Codebase: desktop app'
      : tone === 'loading'
      ? 'Codebase: loading…'
      : tone === 'active'
      ? 'Codebase: analyzing…'
      : tone === 'ready'
      ? 'Codebase: ready'
      : tone === 'error'
      ? 'Codebase: error'
      : 'Codebase: idle';
  const fullHeadline =
    nativeMissing
      ? 'Codebase analysis runs on your machine — open this project in the Ugly Studio desktop app'
      : tone === 'loading'
      ? 'Codebase analysis: loading…'
      : tone === 'active'
      ? 'Codebase analysis running — AI coding quality reduced until ready'
      : tone === 'ready'
      ? 'Codebase analysis ready'
      : tone === 'error'
      ? 'Codebase analysis: error'
      : 'Codebase analysis: not started';

  // Full-detail tooltip. The loading state has no numbers to show yet (the host
  // hasn't reported), so explain WHAT is loading + what to expect rather than a
  // bare "loading…" — this is the "codebase: loading" report the tester hit.
  const detailLines = [archLabel, idxLabel];
  if (tone === 'loading') {
    detailLines.push(
      '',
      'The host indexer is starting up. On first use it downloads a Python',
      'runtime + embedding model — this can take a few minutes, especially on',
      'Windows. Semantic search and architecture-aware answers turn on once it',
      'reports ready. If it stays here for many minutes, the indexer likely',
      'failed to install; reopen the project or report it from this session.',
    );
  } else if (tone === 'active') {
    detailLines.push(
      '',
      'Analysis runs on your machine and can take several minutes on a large',
      'repo (or on Windows, where the indexer is slower). The agent keeps',
      'working while this runs — semantic search + architecture-aware answers',
      'sharpen once it reaches ready. If it never gets there, reopen the',
      'project or report it from this session.',
    );
  } else if (nativeMissing) {
    detailLines.length = 0;
    detailLines.push(
      'Open this project in the Ugly Studio desktop app to enable semantic',
      'search + architecture analysis (a browser tab has no host to run them).',
    );
  }
  const tooltip = [
    fullHeadline,
    ...detailLines,
    '',
    'Click for detailed stats.',
  ].join('\n');

  return (
    <button
      type="button"
      data-id="codebase-readiness-pill"
      data-us-tooltip={tooltip}
      onClick={onOpenStats}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        fontFamily: 'inherit',
        fontSize: 11,
        lineHeight: 'inherit',
        color: 'var(--text-muted)',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 4,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dotColor,
          animation: pulse
            ? 'us-readiness-pulse 1.4s ease-in-out infinite'
            : 'none',
          flexShrink: 0,
        }}
      />
      {shortLabel}
    </button>
  );
}

// ── Dirty-main precheck dialog ──────────────────────────────────

/**
 * Modal shown when the Done pipeline aborts at the dirty-main
 * precheck. Lists the uncommitted files in the main repo and
 * offers two choices:
 *   - "Commit and continue" — re-runs Done with
 *     `commitDirtyMainBeforeMerge: true` so the pipeline `git add -A`
 *     and `git commit`s the dirty files before squashing the session
 *     branch on top of them.
 *   - "Cancel" — bails out of the Done run; the user goes manually
 *     stash / discard / commit and clicks Done again later.
 *
 * The file list is truncated to 12 entries with a `+N more` tail so a
 * pathological case (e.g. user has 50 dirty files) doesn't blow out
 * the modal height.
 */
// ── Scratchpad Panel ────────────────────────────────────────────────

function ScratchpadPanel({
  entries,
  onClose,
}: {
  entries: {
    key: string;
    value: string;
    mergeToMemory: boolean;
    createdAt: number;
    updatedAt: number;
  }[];
  onClose: () => void;
}) {
  return (
    <div
      data-id="finish-modal-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 60,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          width: 500,
          maxHeight: 'calc(100vh - 120px)',
          overflow: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <StickyNote size={16} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>Scratchpad</span>
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              marginLeft: 4,
            }}
          >
            {entries.length} note{entries.length !== 1 ? 's' : ''}
          </span>
          <div style={{ flex: 1 }} />
          <button
            data-id="finish-modal-close"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            <X size={14} />
          </button>
        </div>
        <div style={{ padding: 16 }}>
          {entries.length === 0 ? (
            <div
              style={{
                color: 'var(--text-muted)',
                fontSize: 13,
                textAlign: 'center',
                padding: '24px 0',
              }}
            >
              No scratchpad entries yet.
              <br />
              <span style={{ fontSize: 11 }}>
                The agent will save working notes here during long tasks.
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {entries.map((entry) => (
                <div
                  key={entry.key}
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 12,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: 6,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 12,
                        color: 'var(--text-primary)',
                      }}
                    >
                      {entry.key}
                    </span>
                    {entry.mergeToMemory && (
                      <span
                        style={{
                          fontSize: 9,
                          background: 'var(--accent)',
                          color: '#fff',
                          padding: '1px 5px',
                          borderRadius: 3,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                        }}
                      >
                        → memory
                      </span>
                    )}
                    <div style={{ flex: 1 }} />
                    <span
                      style={{
                        fontSize: 10,
                        color: 'var(--text-muted)',
                      }}
                    >
                      {new Date(entry.updatedAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {entry.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────

export interface CodingAgentChatProps {
  initialSessionId?: string;
  initialModel?: string;
  /**
   * When set, this tab is bound to the given spec. Passed through to
   * the session on create so the server injects a spec-context block
   * in the system prompt and gates `spec_create` out of the tool catalog.
   */
  specId?: string;
  onSessionCreated?: (sessionId: string) => void;
  onModelChanged?: (model: string) => void;
  onTitleChanged?: (title: string) => void;
  /**
   * Fired when a resume attempt fails because the server can find no
   * open project owning `initialSessionId`. The host (Editor) drops
   * the orphan agent tab so the user lands on the new-session hero
   * instead of staring at a permanent error. Typical trigger: the
   * owning project folder was deleted out from under the persisted
   * layout (sess_nqn8v8mympu58yvf, 2026-05-31).
   */
  onResumeMissing?: (sessionId: string) => void;
  /**
   * Called after the user archives this session from inside the chat
   * (Archive button or post-finish "Archive" prompt). The caller is
   * expected to rotate focus to the next live session, or send the
   * user back to Project Home if no live sessions remain. Receives
   * the compositeId of the archived session.
   */
  onSessionArchived?: (compositeId: string) => void;
  /**
   * Optional: open a URI surfaced inside an LLM message. The chat
   * autolinks bare absolute paths and URLs and forwards click targets
   * here. Receives `file:///abs/path[:line[-end]]` for paths and
   * `http(s)://...` for web URLs. When omitted, links fall through to
   * the MdastViewer default (`window.open`).
   */
  onOpenUri?: (uri: string) => void;
  /**
   * Active session's max-mode peer children, derived in `SessionLayout`
   * by filtering the polled sessions list on `parentSessionId`. Empty
   * when the session has no max-mode children. Drives the pill row
   * above the messages, the live status strip, and the per-peer
   * history backfill that fills the interleaved transcript.
   */
  peerSessions?: PeerSessionRef[];
  /**
   * Generic navigation callback — receives the compositeId of any
   * session the chat wants to open in the same shell. Used by the
   * peer pills (open a peer's session) and by the "child of
   * <parent>" banner's parent-link (jump back up to the orchestrator).
   * Host wires this to its `onSelectSession` machinery.
   */
  onOpenSession?: (compositeId: string) => void;
}

function CodingAgentChatInner({
  initialSessionId,
  initialModel,
  specId,
  onSessionCreated,
  onModelChanged,
  onTitleChanged,
  onResumeMissing,
  onSessionArchived,
  peerSessions,
  onOpenSession,
}: // `onOpenUri` is consumed via OpenUriContext (set by the outer
// wrapper). Not destructured here — the wrapper installs the
// provider and the inner has no use for the prop directly.
CodingAgentChatProps = {}) {
  const {
    messages,
    peerMessages,
    peerToolProgress,
    peerLspState,
    peerStuckState,
    isStreaming,
    sendMessage,
    stopGeneration,
    stopTool,
    clearMessages,
    model,
    reasoningEffort,
    switchReasoningEffort,
    pendingSkill,
    setPendingSkill,
    error,
    pendingPermissions,
    approvePermission,
    skipAllPermissions,
    compactNow,
    restoreCheckpoint,
    pendingAskUsers,
    answerAskUser,
    pendingStepReviews,
    answerStepReview,
    serverHealthy,
    features,
    autoModeRouting,
    sessionInfo,
    isResumed,
    isLoadingHistory,
    sessionId,
    worktree,
    worktreeBlocked,
    worktreeStatus,
    worktreeBehind,
    checkWorktreeBehind,
    finishPipeline,
    finishSession,
    mergeFinishedSession,
    stopFinishStage,
    archiveSession,
    refreshWorktreeNow,
    hasMoreOlder,
    hasMoreNewer,
    isLoadingOlder,
    isLoadingNewer,
    loadOlderMessages,
    loadNewerMessages,
    jumpToTail,
    codebaseReadiness,
    // Three-axis state for the pattern strip + axis selector.
    permissionMode,
    modelMode,
    patternMode,
    resolvedPattern,
    currentStepId,
    currentStepIter,
    currentStepFinished,
    setPermissionMode,
    setModelMode,
    setPatternMode,
    setBranchMode,
  } = useCodingAgentChat({
    initialSessionId,
    initialModel,
    specId,
    onSessionCreated,
    onModelChanged,
    onTitleChanged,
    ...(onResumeMissing ? { onResumeMissing } : {}),
  });
  // Contribute the live coding session (messages + model/mode settings) to any
  // Ugly Studio feedback report filed from this page. The bundle is expensive to
  // serialize, so we register a LAZY provider (invoked only at submit time) rather
  // than keeping a serialized copy alive — we just stash the live state in a ref
  // (O(1) each render) and cap+stringify on demand inside the provider callback.
  const feedbackBundleRef = useRef<Record<string, unknown>>({});
  feedbackBundleRef.current = {
    compositeId: sessionId,
    messages,
    model,
    reasoningEffort,
    modelMode,
    patternMode,
  };
  useEffect(
    () =>
      registerFeedbackContextProvider('sessionBundle', (): Record<string, string> =>
        sessionId
          ? { sessionBundle: JSON.stringify(capSessionBundle(feedbackBundleRef.current)) }
          : {},
      ),
    [sessionId],
  );

  // Diagnostics for "codebase: loading" / broken-semantic-search reports. The
  // client can't see WHY the indexer is stuck from the pill alone, so a report
  // carries: whether the native host is present, the project path (Windows vs
  // posix), the client-side readiness the pill reflects (null ⇒ still loading),
  // AND a FRESH host `codebase.status` pulled at submit time (async provider) so
  // we see the actual indexer/architecture state rather than the last poll.
  const codebaseReadinessRef = useRef<unknown>(null);
  codebaseReadinessRef.current = codebaseReadiness ?? null;
  // Shared by BOTH pill render sites (empty-session + active-session toolbars),
  // so the modal exists once regardless of which pill was clicked.
  const [codebaseStatsOpen, setCodebaseStatsOpen] = useState(false);
  useEffect(
    () =>
      registerFeedbackContextProvider(
        'codebaseDiagnostics',
        async (): Promise<Record<string, string>> => {
          const cwd = getActiveProjectPath() ?? '';
          const activeRepo = new URLSearchParams(window.location.search).get('repo');
          const diag: Record<string, unknown> = {
            nativeAvailable: isNativeAvailable(),
            cwd,
            activeRepo,
            userAgent: navigator.userAgent,
            readiness: codebaseReadinessRef.current,
          };
          if (isNativeAvailable() && cwd) {
            try {
              diag.freshStatus = await fetchCodebaseStatus(cwd);
            } catch (e) {
              diag.statusError = e instanceof Error ? e.message : String(e);
            }
          }
          return { codebaseDiagnostics: JSON.stringify(diag) };
        },
      ),
    [],
  );

  const globalActiveSpec = useActiveSpec();
  // Per-session spec takes precedence over the global "studio
  // active spec". The global value only tracks what the Specs tab
  // last focused on; it never fires automatically when the coding
  // agent itself runs `spec_write`, so relying on it alone meant
  // the Build-from-spec button stayed hidden even after the agent
  // had written a full spec. `sessionInfo.specId` comes from every
  // `session` event (see emitSession in session.ts) and is the
  // authoritative per-session binding.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- keep the side-effectful useActiveSpec() subscription wired; consumer JSX pending
  const activeSpec: ActiveSpec | null = sessionInfo?.specId
    ? { id: sessionInfo.specId, title: sessionInfo.title ?? '' }
    : globalActiveSpec;
  const [showScratchpad, setShowScratchpad] = useState(false);

  // ModelSelector in subscriptions-only mode fires this when the user
  // clicks a locked (no-credentials) row. Editor.tsx owns the settings
  // modal, so we hand the provider off via a window event rather than
  // threading an `onOpenSettings` prop through SessionLayout and
  // AgentsPanel. Matches the existing `ugly-studio:open-git-panel`
  // pattern.
  const handleModelNeedsKey = useCallback((provider: SubscriptionProvider) => {
    window.dispatchEvent(
      new CustomEvent('ugly-studio:open-settings', { detail: { provider } }),
    );
  }, []);

  // The new-session hero renders as the empty-state body. Its "Start"
  // handler must NOT create a new session (this session already exists —
  // main, or an eagerly-created worktree session). Instead apply the hero's
  // axis picks to THIS session and send the first message. Awaits the model
  // apply first: a Claude-CLI <-> ugly.bot pick converts the backend in
  // place, and the message must land on the converted backend.
  const handleHeroOpenSettings = useCallback(
    (provider?: SubscriptionProvider) => {
      window.dispatchEvent(
        new CustomEvent('ugly-studio:open-settings', {
          detail: provider ? { provider } : {},
        }),
      );
    },
    [],
  );
  const handleHeroSubmit = useCallback(

    async (params: NewSessionStartParams) => {
      // Apply the axis picks to THIS session, model first (it may convert
      // the backend in place for a Claude-CLI <-> ugly.bot switch).
      await setModelMode(params.modelMode);
      void setPermissionMode(params.permissionMode);
      void setPatternMode(params.patternMode);
      switchReasoningEffort(params.reasoningEffort);
      // Branch mode is set via synchronous ref so startNewChat picks it up.
      setBranchMode(params.branchMode);
      const trimmed = params.prompt.trim();
      if (trimmed) await sendMessage(trimmed);
    },
    [
      setModelMode,
      setPermissionMode,
      setPatternMode,
      switchReasoningEffort,
      setBranchMode,
      sendMessage,
    ],
  );

  // True when this chat panel is bound to a max-mode peer session
  // (`sessionInfo.parentSessionId` set means the parent orchestrator
  // owns the turn loop). The prompt input + axis/model/reasoning
  // controls are disabled — the user opens the peer to *watch* the
  // run, not to fight the orchestrator. Going up to the parent's
  // session is one click in the sidebar.
  const isChildSession = Boolean(sessionInfo?.parentSessionId);
  // Anything that should disable on streaming should ALSO disable on
  // child sessions. Saves repeating the OR everywhere.
  const interactionDisabled = isStreaming || isChildSession;

  // Finish-session UX. Done click auto-runs all gates (no dialog).
  // After a stage fails the user can either "Fix with AI" (existing
  // auto-fix loop, only available for tsc/lint) or "Skip" — which
  // re-runs the whole pipeline with that gate disabled. After a
  // successful finish, prompt the user to archive the session.
  interface FinishGates {
    runTypecheck: boolean;
    runLint: boolean;
    runTests: boolean;
  }
  const ALL_GATES_ON: FinishGates = {
    runTypecheck: true,
    runLint: true,
    runTests: true,
  };
  const [showArchivePrompt, setShowArchivePrompt] = useState(false);

  // (The previous finishPopupRef + auto-scroll effect lived here to
  // pin the pinned-top progress card to its latest streamed line.
  // Both moved into `DoneCard` along with the rest of the inline
  // finish-pipeline UI — see the DoneCard component above.)

  // Refs that track the latest finishPipeline + isStreaming + worktree
  // values so the runFinish closure can read them without re-running
  // the auto-fix loop on every state update.
  const finishPipelineRef = useRef(finishPipeline);
  const isStreamingRef = useRef(isStreaming);
  const worktreeRef = useRef(worktree);
  useEffect(() => {
    finishPipelineRef.current = finishPipeline;
  }, [finishPipeline]);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);
  useEffect(() => {
    worktreeRef.current = worktree;
  }, [worktree]);

  // Wait for the current AI turn to finish. Used by the Finish auto-fix
  // loop to pause between sending a fix request and re-running gates.
  // Gives streaming up to 5s to start before giving up so a failed send
  // doesn't hang the loop forever.
  const waitForStreamEnd = useCallback(async () => {
    const startDeadline = Date.now() + 5000;
    while (!isStreamingRef.current && Date.now() < startDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    while (isStreamingRef.current) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }, []);

  // Confirmation dialog state for the dirty-main precheck. When the
  // Done pipeline aborts at `precheck_dirty_main`, the chat panel
  // shows a modal listing the uncommitted files and two buttons:
  // "Commit and continue" (re-runs Done with
  // `commitDirtyMainBeforeMerge: true` so the pipeline auto-commits
  // those files first) or "Cancel" (bails out). The Promise that
  // `runFinish` is awaiting resolves with the user's choice.
  const [dirtyMainPrompt, setDirtyMainPrompt] = useState<{
    files: string[];
  } | null>(null);
  const dirtyMainResolveRef = useRef<((commit: boolean) => void) | null>(null);
  const askDirtyMainPrompt = useCallback(
    (files: string[]): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        dirtyMainResolveRef.current = resolve;
        setDirtyMainPrompt({ files });
      }),
    [],
  );
  const resolveDirtyMainPrompt = useCallback((commit: boolean) => {
    const fn = dirtyMainResolveRef.current;
    dirtyMainResolveRef.current = null;
    setDirtyMainPrompt(null);
    if (fn) fn(commit);
  }, []);

  // Review-changes-before-merge modal. Populated when the server
  // pipeline returns `stage: 'awaiting_review'` after validation gates
  // pass; cleared on Accept (squash lands) or Reject (worktree
  // preserved, session stays open).
  const [reviewModal, setReviewModal] = useState<{
    proposedCommitMessage: string;
    parentBranch: string;
    sessionBranch: string;
    worktreePath: string;
  } | null>(null);

  // Stage-specific failure modal. Shown when auto-fix attempts are
  // exhausted (3 tries) or a non-retryable stage (tests, cleanup,
  // merge_squash conflict) fails. Replaces the inline "Fix with AI" /
  // "Resolve with AI" buttons that used to live on the progress card.
  const [failurePopup, setFailurePopup] = useState<FinishFailureInfo | null>(
    null,
  );

  const openFailurePopup = useCallback(
    (
      stage: FinishFailureInfo['stage'],
      result: {
        message?: string;
        conflicts?: string[];
        dirtyFiles?: string[];
      },
    ) => {
      const stageInfo = finishPipelineRef.current.stages.find(
        (s) =>
          s.name === stage ||
          (stage === 'conflict' &&
            (s.name === 'merge_parent' || s.name === 'merge_squash')),
      );
      setFailurePopup({
        stage,
        ...(stage === 'conflict' && finishPipelineRef.current.conflictStage
          ? { conflictStage: finishPipelineRef.current.conflictStage }
          : {}),
        ...(result.message ? { message: result.message } : {}),
        ...(result.conflicts ? { conflicts: result.conflicts } : {}),
        ...(result.dirtyFiles ? { dirtyFiles: result.dirtyFiles } : {}),
        ...(stageInfo?.output ? { lastStageOutput: stageInfo.output } : {}),
      });
    },
    [],
  );

  const runFinish = useCallback(
    async (gates: FinishGates = ALL_GATES_ON) => {
      setShowArchivePrompt(false);
      setFailurePopup(null);
      const MAX_AUTOFIX_ATTEMPTS = 3;
      // Carries across loop iterations: once the user has confirmed
      // "commit and continue" on the dirty-main precheck, we keep
      // sending `commitDirtyMainBeforeMerge: true` for the rest of the
      // run so a subsequent dirty state (rare but possible — e.g.
      // hooks that touch the working tree) re-commits silently.
      let commitDirtyMainBeforeMerge = false;
      for (let attempt = 0; attempt <= MAX_AUTOFIX_ATTEMPTS; attempt++) {
        const result = await finishSession({
          ...gates,
          // Pause before the squash so the chat UI can render the
          // review modal. Accept/Reject is gated through the
          // `mergeFinishedSession` RPC (Accept) or no-op (Reject).
          pauseBeforeSquash: true,
          ...(commitDirtyMainBeforeMerge
            ? { commitDirtyMainBeforeMerge: true }
            : {}),
        });
        // Validation passed and the server is waiting for review. Open
        // the modal — Accept will fire `mergeFinishedSession`. We don't
        // loop further; the merge RPC owns the squash + cleanup tail.
        if (result.stage === 'awaiting_review') {
          setReviewModal({
            proposedCommitMessage: result.proposedCommitMessage ?? '',
            parentBranch:
              result.parentBranch ?? worktreeRef.current?.parentBranch ?? '',
            sessionBranch:
              result.sessionBranch ?? worktreeRef.current?.branch ?? '',
            worktreePath:
              result.worktreePath ?? worktreeRef.current?.path ?? '',
          });
          return;
        }
        if (result.ok) {
          // No-op finish (no commits to merge) short-circuits
          // server-side without a review pause; treat it as success.
          setShowArchivePrompt(true);
          return;
        }
        const failedStage = result.stage;
        // Dirty main repo at squash time. Ask the user whether to
        // commit the local edits in main first; on confirm, retry the
        // pipeline with `commitDirtyMainBeforeMerge: true` so the
        // server auto-commits before squashing. On cancel, the Done
        // run ends with no merge — exactly what the user picked.
        if (failedStage === 'precheck_dirty_main') {
          if (attempt >= MAX_AUTOFIX_ATTEMPTS) {
            openFailurePopup('precheck_dirty_main', result);
            return;
          }
          const files = result.dirtyFiles ?? [];
          const commit = await askDirtyMainPrompt(files);
          if (!commit) return;
          commitDirtyMainBeforeMerge = true;
          continue;
        }
        // Auto-resolve merge conflicts: when merge_parent or
        // merge_squash conflicts hit, fire the same "reconcile these
        // markers" prompt the worktree-banner uses, wait for the
        // agent to finish resolving + committing, then re-run. No
        // user click needed — the user already chose to finish.
        if (failedStage === 'conflict') {
          if (attempt >= MAX_AUTOFIX_ATTEMPTS) {
            openFailurePopup('conflict', result);
            return;
          }
          const conflicts = result.conflicts ?? [];
          if (conflicts.length === 0) {
            openFailurePopup('conflict', result);
            return;
          }
          const parentBranch =
            finishPipelineRef.current.conflictStage === 'merge_squash'
              ? 'parent'
              : worktreeRef.current?.parentBranch ?? 'parent';
          const fileList = conflicts.map((f) => `- \`${f}\``).join('\n');
          const conflictMsg =
            `Merge from \`${parentBranch}\` produced conflicts during Finish.\n\n` +
            `**Conflicting files:**\n${fileList}\n\n` +
            '**Resolve:**\n' +
            '1. Reconcile the `<<<<<<<` / `=======` / `>>>>>>>` markers in each file. Keep edits minimal — do not touch unrelated code.\n' +
            '2. `git add` each resolved file.\n' +
            '3. `git commit` with no `-m` flag, letting git use the default merge message.\n\n' +
            `After you commit, I will automatically re-run the Finish pipeline.`;
          await sendMessage(conflictMsg);
          await waitForStreamEnd();
          continue;
        }
        // Auto-fix typecheck + lint via the AI; tests and cleanup are
        // not retried (a failing test usually flags real intent
        // conflict). Either way, on exhaustion we surface the
        // FinishFailurePopup with stage-specific guidance.
        if (failedStage !== 'tsc' && failedStage !== 'lint') {
          if (
            failedStage === 'tests' ||
            failedStage === 'cleanup' ||
            failedStage === 'merge_squash' ||
            failedStage === 'merge_parent'
          ) {
            openFailurePopup(failedStage, result);
          }
          return;
        }
        if (attempt >= MAX_AUTOFIX_ATTEMPTS) {
          openFailurePopup(failedStage, result);
          return;
        }
        const stages = finishPipelineRef.current.stages;
        const stageInfo = stages.find((s) => s.name === failedStage);
        if (!stageInfo?.output) {
          openFailurePopup(failedStage, result);
          return;
        }
        const fixMsg =
          `\`${
            stageInfo.command ?? failedStage
          }\` failed during Finish. Fix the underlying issues — keep changes minimal, do not touch unrelated code.\n\nOutput:\n\n\`\`\`\n${stageInfo.output.slice(
            -4000,
          )}\n\`\`\`\n\n` +
          `After your fix I will automatically re-run the Finish pipeline.`;
        await sendMessage(fixMsg);
        await waitForStreamEnd();
      }
    },
    [
      finishSession,
      sendMessage,
      waitForStreamEnd,
      askDirtyMainPrompt,
      openFailurePopup,
    ],
  );

  // Accept the review modal: run the squash + cleanup tail. The user
  // may have edited the commit message; pass the trimmed value through
  // (server falls back to its derived default on empty).
  const handleReviewAccept = useCallback(
    async (commitMessage: string) => {
      const res = await mergeFinishedSession(commitMessage);
      setReviewModal(null);
      if (res.ok) {
        setShowArchivePrompt(true);
        return;
      }
      // The most likely failure here is a parent-moved squash
      // conflict; surface it through the failure popup so the user can
      // pull the parent in the main repo and click Retry Finish.
      openFailurePopup(
        res.stage === 'conflict'
          ? 'conflict'
          : (res.stage as FinishFailureInfo['stage'] | undefined) ??
            'merge_squash',
        res,
      );
    },
    [mergeFinishedSession, openFailurePopup],
  );

  const handleReviewReject = useCallback(() => {
    setReviewModal(null);
  }, []);

  /**
   * Re-run the Finish pipeline with the named gate disabled. Other
   * gates default back to enabled so a Skip on a previously-failed
   * step does not implicitly skip later steps the user hasn't decided
   * about. The whole pipeline re-runs (re-running already-passed
   * gates is wasted work but keeps the server side simple — the
   * existing auto-fix loop already does the same).
   */
  const skipFailedStage = useCallback(
    (stage: 'tsc' | 'lint' | 'tests') => {
      void runFinish({
        runTypecheck: stage !== 'tsc',
        runLint: stage !== 'lint',
        runTests: stage !== 'tests',
      });
    },
    [runFinish],
  );

  const handleArchiveSession = useCallback(async () => {
    setShowArchivePrompt(false);
    const ok = await archiveSession();
    if (ok && sessionId && onSessionArchived) {
      onSessionArchived(sessionId);
    }
  }, [archiveSession, sessionId, onSessionArchived]);

  // Poll the session's git worktree for changed files. The Finish
  // button is gated on there being actual work to merge — when the
  // agent hasn't modified anything yet, Finish is a no-op and just
  // adds noise. Scoped to `worktree.path` so it reflects the
  // session's branch, not the main repo.
  // Keep the git-status poll wired (worktree branch/changes) even though
  // this consumer doesn't read the count directly.
  useGitStatus(3000, worktree?.path ?? undefined);

  // Backfill peer message history when the parent session resumes
  // mid- or post-max-mode. Live `peer_event`s only deliver new
  // messages from the moment the chat panel mounts; without this
  // backfill, switching to "All" after a sidecar restart shows an
  // empty banner even when each peer's session.json on disk has a
  // full transcript. We fetch each peer's messages once via
  // `chatListMessages` and stash them in a panel-local state slice
  // that the banner concatenates with the live `peerMessages`.
  const [historicalPeerMessages, setHistoricalPeerMessages] = useState<
    PeerMessage[]
  >([]);
  const fetchedPeersRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    fetchedPeersRef.current = new Set();
    setHistoricalPeerMessages([]);
  }, [sessionId]);
  // Build a stable signature so SessionLayout's 4s polling refresh
  // (which gives us a new `peerSessions` array reference every tick
  // even when nothing changed) doesn't tear down a fetch mid-flight.
  // Re-run only when the actual roster of compositeIds changes.
  const peerRosterKey = useMemo(
    () =>
      (peerSessions ?? [])
        .map((p) => p.compositeId)
        .sort()
        .join('|'),
    [peerSessions],
  );
  useEffect(() => {
    if (!peerSessions || peerSessions.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const peer of peerSessions) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set true by cleanup across the await; flow analysis can't see the async gap
        if (cancelled) return;
        if (fetchedPeersRef.current.has(peer.compositeId)) continue;
        try {
          const res = await fetch('/api/codingAgentChatListMessages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              input: { sessionId: peer.compositeId, limit: 200 },
            }),
          });
          const json = (await res.json()) as {
            result?: { messages?: unknown };
            messages?: unknown;
          };
          const list = (json.result?.messages ?? json.messages) as
            | {
                id?: string;
                role?: string;
                parts?: unknown[];
                created_at?: number;
              }[]
            | undefined;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set true by cleanup across the await; flow analysis can't see the async gap
          if (cancelled) return;
          if (!Array.isArray(list)) continue;
          const tagged: PeerMessage[] = list
            .filter(
              (
                m,
              ): m is {
                id: string;
                role: string;
                parts: unknown[];
                created_at?: number;
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- untrusted JSON: array entries may be null at runtime
              } => typeof m?.id === 'string' && typeof m?.role === 'string',
            )
            .map((m) => ({
              peerModelId: peer.model,
              message: {
                id: m.id,
                role: m.role,
                parts: m.parts as
                  | { type: string; data?: unknown }[]
                  | undefined,
                ...(m.created_at !== undefined && { created_at: m.created_at }),
              },
            }));
          setHistoricalPeerMessages((prev) => {
            const seen = new Set(prev.map((p) => p.message.id));
            const incoming = tagged.filter((p) => !seen.has(p.message.id));
            return [...prev, ...incoming];
          });
          // Mark fetched only AFTER the response is committed. Marking
          // before the await meant a cleanup-cancelled fetch left the
          // peer flagged as "done" with zero messages stashed, and the
          // re-mounted effect would skip it forever.
          fetchedPeersRef.current.add(peer.compositeId);
        } catch (err) {
          console.warn(
            '[CodingAgentChat] peer history backfill failed for %s: %s',
            peer.model,
            (err as Error).message,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerRosterKey, sessionId]);
  // Live peer messages take precedence (they're the authoritative
  // streaming view); historical entries fill in everything before
  // the chat panel mounted (e.g. across a sidecar restart).
  const allPeerMessages = useMemo<PeerMessage[]>(() => {
    if (historicalPeerMessages.length === 0) return peerMessages;
    const liveIds = new Set(peerMessages.map((p) => p.message.id));
    return [
      ...historicalPeerMessages.filter((p) => !liveIds.has(p.message.id)),
      ...peerMessages,
    ];
  }, [peerMessages, historicalPeerMessages]);

  // Interleaved transcript: parent's messages chronologically merged
  // with each peer's projected transcript. Each peer's raw messages
  // are folded through the same `projectAgentMessagesToChat` reducer
  // the parent uses (so tool results land on the right tool_calls),
  // then tagged with the peer's modelId — the row renderer below
  // surfaces a small model badge above any row that carries one.
  // Falls back to plain `messages` when there are no peers, so the
  // virtualizer stays cheap on non-max-mode sessions.
  const displayMessages = useMemo<ChatMessage[]>(() => {
    if (allPeerMessages.length === 0 || isChildSession) return messages;
    const byPeer = new Map<string, RawAgentMessage[]>();
    for (const pm of allPeerMessages) {
      const list = byPeer.get(pm.peerModelId) ?? [];
      list.push(pm.message);
      byPeer.set(pm.peerModelId, list);
    }
    const peerChats: ChatMessage[] = [];
    for (const [peerModelId, raws] of byPeer) {
      // Fold each peer's transcript independently — tool results from
      // peer A shouldn't merge into tool calls on peer B.
      const folded = projectAgentMessagesToChat(raws);
      for (const c of folded) peerChats.push({ ...c, peerModelId });
    }
    const merged = [...messages, ...peerChats];
    merged.sort(
      (a, b) =>
        (a.created_at ?? Number.POSITIVE_INFINITY) -
        (b.created_at ?? Number.POSITIVE_INFINITY),
    );
    return merged;
  }, [messages, allPeerMessages, isChildSession]);

  // Build a "please reconcile these conflicts" prompt and send it to
  // the agent. The wording branches on `kind` because the two
  // conflict states need different finalization commands:
  //   - 'merge' → resolve markers, git add, git commit
  //   - 'stash_apply' → resolve markers, git add, git stash drop
  // (The pull flow autostashes the worktree's wip changes before
  // merging; merge conflicts surface from parent's history, while
  // stash-apply conflicts surface when the wip work overlaps with
  // newly-merged parent changes.)
  const triggerConflictResolution = useCallback(
    (
      conflicts: string[],
      parentBranch: string,
      kind: 'merge' | 'stash_apply' = 'merge',
    ) => {
      if (conflicts.length === 0) return;
      const fileList = conflicts.map((f) => `- \`${f}\``).join('\n');
      const headline =
        kind === 'stash_apply'
          ? `Pull from \`${parentBranch}\` merged cleanly, but re-applying my in-progress edits hit conflicts.`
          : `Merge from \`${parentBranch}\` produced conflicts.`;
      const finalize =
        kind === 'stash_apply'
          ? '3. `git stash drop` (do **not** run `git commit` — there is no merge in progress).'
          : '3. `git commit` with no `-m` flag, letting git use the default merge message.';
      const msg =
        `${headline}\n\n` +
        `**Conflicting files:**\n${fileList}\n\n` +
        '**Resolve:**\n' +
        '1. Reconcile the `<<<<<<<` / `=======` / `>>>>>>>` markers in each file. Keep edits minimal — do not touch unrelated code.\n' +
        '2. `git add` each resolved file.\n' +
        finalize;
      void sendMessage(msg);
    },
    [sendMessage],
  );

  const autoResolveWorktreeConflict = useCallback(() => {
    if (!worktreeStatus?.conflicts || worktreeStatus.conflicts.length === 0)
      return;
    // Resume-time / banner path doesn't carry the kind, so default
    // to 'merge' — that's the historic behavior and matches what
    // arrives via worktree_event from a non-pull refresh path.
    triggerConflictResolution(
      worktreeStatus.conflicts,
      worktree?.parentBranch ?? 'parent',
      'merge',
    );
  }, [worktree, worktreeStatus, triggerConflictResolution]);

  // Auto-trigger AI resolution when the worktree banner transitions
  // into `refresh_conflict`. Replaces the old explicit "Resolve with
  // AI" button — the user already opted in to AI assistance by
  // running a coding agent session, so further clicks are noise.
  // Tracks previous status via a ref so we only fire on the
  // transition (not every poll tick), and defers while a turn is in
  // flight so we don't interrupt the agent mid-edit.
  const prevRefreshConflictRef = useRef(false);
  useEffect(() => {
    const isConflict = worktreeStatus?.kind === 'refresh_conflict';
    if (
      isConflict &&
      !prevRefreshConflictRef.current &&
      !isStreaming &&
      worktreeStatus.conflicts &&
      worktreeStatus.conflicts.length > 0
    ) {
      autoResolveWorktreeConflict();
    }
    prevRefreshConflictRef.current = isConflict;
  }, [worktreeStatus, isStreaming, autoResolveWorktreeConflict]);

  // Local in-flight guard for the header "Pull from parent" button
  // so a double-click can't race two refreshes.
  const [pullInFlight, setPullInFlight] = useState(false);

  const onPullParent = useCallback(async () => {
    if (pullInFlight) return;
    setPullInFlight(true);
    try {
      const res = await refreshWorktreeNow();
      if (res.ok && res.blocked && res.conflicts && res.conflicts.length > 0) {
        triggerConflictResolution(
          res.conflicts,
          worktree?.parentBranch ?? 'parent',
          res.conflictKind ?? 'merge',
        );
      }
      // Re-probe the behind state so the button disables itself once
      // the merge succeeds (or stays enabled if a conflict left us
      // ahead-of-parent without a clean tip match).
      void checkWorktreeBehind();
    } finally {
      setPullInFlight(false);
    }
  }, [
    pullInFlight,
    refreshWorktreeNow,
    worktree,
    triggerConflictResolution,
    checkWorktreeBehind,
  ]);

  const [scratchpadEntries, setScratchpadEntries] = useState<
    ScratchpadEntry[]
  >([]);
  // Fetch scratchpad entries on session mount, after each AI turn ends,
  // and whenever the panel is opened. Drives the count badge so the
  // bottom-bar scratchpad button only appears when entries exist.
  useEffect(() => {
    if (!sessionId) return;
    if (isStreaming) return;
    fetch('/api/codingAgentGetScratchpad', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ input: { sessionId } }),
    })
      .then((r) => r.json())
      .then((json: { result?: { entries?: unknown }; entries?: unknown }) => {
        const entries = json.result?.entries ?? json.entries;
        if (Array.isArray(entries))
          setScratchpadEntries(entries as ScratchpadEntry[]);
      })
      .catch(() => {
        /* ignore */
      });
  }, [sessionId, isStreaming, showScratchpad]);

  const [input, setInput] = useState('');
  // ── Eval-mode integration ──────────────────────────────────────────
  // When the session is eval-bound (created from the ProjectHome
  // picker), three behaviors layer on top of the normal chat:
  //   1. Pre-fill the textarea with turn[0] on mount (no auto-send).
  //   2. After the agent finishes a turn (isStreaming false → true →
  //      false transition), auto-send turn[currentTurnIndex] if more
  //      turns remain.
  //   3. After the FINAL turn completes, show a "Grade run" button
  //      below the input strip; click runs `evalGradeSession` and
  //      renders the inline scorecard.
  // The scorecard itself survives app restart because it's persisted
  // server-side on `eval.json` and surfaced via the session snapshot.
  const evalState = sessionInfo?.eval ?? null;
  const evalTaskName = evalState?.taskName ?? null;
  const evalGradeResult = evalState?.evalGradeResult ?? null;
  const [evalTaskTurns, setEvalTaskTurns] = useState<string[] | null>(null);
  const [evalGrading, setEvalGrading] = useState(false);
  const [evalGradeError, setEvalGradeError] = useState<string | null>(null);
  // Local grade override — when we just clicked Grade, we have the
  // fresh result before the snapshot has propagated. Falls back to the
  // snapshot-derived `evalGradeResult` when null.
  const [evalLocalGrade, setEvalLocalGrade] = useState<
    import('../shared/api').EvalGradeResult | null
  >(null);
  const evalScorecardResult = evalLocalGrade ?? evalGradeResult ?? null;
  // Scoreboard modal visibility. Auto-opens the first time a fresh
  // grade lands so the user sees the result; the "Show scoreboard"
  // button lets them re-open after dismissing without re-running the
  // grader. We use a separate `seenGradeIso` ref so subsequent
  // snapshot pushes (which carry the same `gradedAt`) don't keep
  // re-opening the modal after the user closed it.
  const [evalScorecardModalOpen, setEvalScorecardModalOpen] = useState(false);
  const lastAutoOpenedGradeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!evalScorecardResult) return;
    if (lastAutoOpenedGradeRef.current === evalScorecardResult.gradedAt) return;
    lastAutoOpenedGradeRef.current = evalScorecardResult.gradedAt;
    setEvalScorecardModalOpen(true);
  }, [evalScorecardResult]);
  const socket = useSocket();
  // Cache the task turns so the auto-fire path doesn't refetch on
  // every isStreaming flip.
  useEffect(() => {
    if (!evalTaskName) {
      setEvalTaskTurns(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await socket.request('evalGetTask', {
          taskName: evalTaskName,
        });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set true by cleanup across the await; flow analysis can't see the async gap
        if (!cancelled) setEvalTaskTurns(res.turns);
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set true by cleanup across the await; flow analysis can't see the async gap
        if (!cancelled)
          console.warn('[eval] evalGetTask failed:', (err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [evalTaskName, socket]);
  // Pre-fill turn[0] when the chat mounts onto an empty eval session.
  // SessionStorage-bridged from ProjectHome carries the prompt across
  // route; if that's missing (e.g. session resumed from disk after
  // restart) we use the task turns we just loaded.
  useEffect(() => {
    if (!sessionId || evalState?.currentTurnIndex !== 0) return;
    if (input !== '') return;
    const bridge = sessionStorage.getItem(
      `eval-first-turn-prompt:${sessionId}`,
    );
    if (bridge) {
      sessionStorage.removeItem(`eval-first-turn-prompt:${sessionId}`);
      setInput(bridge);
      return;
    }
    const fromTask = evalTaskTurns?.[0];
    if (fromTask) setInput(fromTask);
    // We intentionally don't watch `input` — only pre-fill once when
    // the eval state first lands AND the input is empty. User edits
    // afterwards stick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, evalState, evalTaskTurns]);
  // Track previous `isStreaming` so we can detect both the rising
  // edge (turn started — stamp `runStartedAt`) and the falling edge
  // (turn complete — bump turn index + auto-fire the next turn).
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (!evalState || !evalTaskTurns || !sessionId) return;

    // Rising edge — agent started its first turn. Stamp runStartedAt
    // now so the scorecard's wall-clock measures from "agent began
    // work" to "grader fired". Previously this was deferred until
    // the falling edge (after the first turn finished) which made
    // the reported duration ~0 for fast turns and arbitrary for any
    // turn that ran longer than ~zero seconds — the start stamp was
    // landing AFTER the agent had already produced its result event.
    // Server stamps only on the first call (`!cur.runStartedAt`
    // guard in advanceTurnIndex) so subsequent rising edges are
    // harmless no-ops.
    if (!wasStreaming && isStreaming && !evalState.runStartedAt) {
      void socket
        .request('evalAdvanceTurn', {
          sessionId,
          nextTurnIndex: evalState.currentTurnIndex,
        })
        .catch(() => {
          /* noop */
        });
      return;
    }
    // Falling edge — turn finished. Bump the server-side turn index
    // for the turn that JUST finished. We treat the current value as
    // "we just dispatched this index"; on completion we bump to
    // currentTurnIndex+1.
    if (wasStreaming && !isStreaming) {
      const justFinishedIndex = evalState.currentTurnIndex;
      const nextIndex = justFinishedIndex + 1;
      void socket
        .request('evalAdvanceTurn', { sessionId, nextTurnIndex: nextIndex })
        .catch(() => {
          /* noop */
        });
      // Auto-fire the next turn if any remain.
      if (nextIndex < evalTaskTurns.length) {
        const nextTurn = evalTaskTurns[nextIndex];
        if (nextTurn) {
          void sendMessage(nextTurn);
        }
      }
    }
  }, [isStreaming, evalState, evalTaskTurns, sessionId, sendMessage, socket]);
  const handleGradeEval = useCallback(async () => {
    if (!sessionId || evalGrading) return;
    setEvalGrading(true);
    setEvalGradeError(null);
    try {
      const result = await socket.request(
        'evalGradeSession',
        { sessionId, ...(evalTaskName ? { taskName: evalTaskName } : {}) },
        { timeoutMs: 180_000 },
      );
      setEvalLocalGrade(result);
    } catch (err) {
      console.error('[CodingAgentChat:evalGradeSession]', JSON.stringify({ sessionId, taskName: evalTaskName === '' ? undefined : evalTaskName, error: err instanceof Error ? err.message : String(err) }), err instanceof Error ? err.stack : undefined);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a non-Error throw makes .message undefined at runtime despite the cast
      setEvalGradeError((err as Error).message ?? 'grading failed');
    } finally {
      setEvalGrading(false);
    }
  }, [sessionId, evalGrading, socket, evalTaskName]);
  const evalAllTurnsDone =
    !!evalState &&
    !!evalTaskTurns &&
    evalState.currentTurnIndex >= evalTaskTurns.length &&
    !isStreaming;

  /**
   * Pending image attachments staged in the composer. Populated by
   * paste / drop / file-picker; cleared once `sendMessage` returns.
   * Lives at the panel scope (not inside the input component) because
   * `handleSend` is here and forwards them to `sendMessage`.
   */
  const [attachments, setAttachments] = useState<
    {
      kind: 'image';
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      base64: string;
      filename?: string;
    }[]
  >([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  // When we programmatically jump the list to the bottom we briefly
  // suppress the scroll handler — otherwise the scroll event from our
  // own jump flips `userScrolledRef` to true and the auto-follow stops.
  const suppressScrollRef = useRef(false);
  const history = useInputHistory(
    'inputHistory:codingAgentChat',
    input,
    setInput,
  );

  // Find the most recent todos tool call IN THE CURRENT TURN only —
  // walk back from the end and stop at the most recent user message.
  // Todos are scoped to the live turn: a fresh user prompt clears the
  // pinned bar so the previous turn's checklist doesn't carry over
  // until the agent has had a chance to write a new one.
  const latestTodos = useMemo<TodoItem[] | null>(() => {
    let turnStart = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        turnStart = i + 1;
        break;
      }
    }
    return findTurnTodos(messages, turnStart, messages.length - 1);
  }, [messages]);

  // Critique-group counters. Lifted out of the render loop into a
  // memo so per-row rendering is O(1).
  const { critiqueGroupIndex, critiqueGroupTotal } = useMemo(() => {
    const idx: number[] = new Array<number>(messages.length).fill(0);
    const total: number[] = new Array<number>(messages.length).fill(0);
    let groupStart = 0;
    let seenInGroup = 0;
    const finalizeGroup = (endExclusive: number) => {
      for (let k = groupStart; k < endExclusive; k++) {
        if (idx[k] > 0) total[k] = seenInGroup;
      }
    };
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'user' && !m.content.includes(CRITIQUE_MARKER_CLIENT)) {
        finalizeGroup(i);
        groupStart = i;
        seenInGroup = 0;
      } else if (
        m.role === 'user' &&
        m.content.includes(CRITIQUE_MARKER_CLIENT)
      ) {
        seenInGroup += 1;
        idx[i] = seenInGroup;
      }
    }
    finalizeGroup(messages.length);
    return { critiqueGroupIndex: idx, critiqueGroupTotal: total };
  }, [messages]);

  const getItemKey = useCallback(
    (i: number) => displayMessages[i]?.id ?? i,
    [displayMessages],
  );

  // Id of the most-recent `role: 'status'` message — only that entry's
  // `DoneCard` renders the "Done — merge" button, the live finish
  // pipeline, and the inline modals (dirty-main, review, failure,
  // archive). Older done entries become read-only summaries.
  const latestStatusId = useMemo<string | null>(() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      const m = displayMessages[i];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access can be undefined at runtime (noUncheckedIndexedAccess is off)
      if (m?.role === 'status') return m.id;
    }
    return null;
  }, [displayMessages]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: displayMessages.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 120,
    overscan: 8,
    getItemKey,
  });

  const pinToBottom = useCallback(() => {
    if (userScrolledRef.current) return;
    const el = listRef.current;
    if (!el) return;
    suppressScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      suppressScrollRef.current = false;
    });
  }, []);

  // Re-pin on growth.
  //
  // The previous version of this effect re-pinned only when
  // `virtualizer.getTotalSize()` grew, gated on `[messages, ...]`.
  // That fires once per message-add — against the virtualizer's
  // *estimated* total (estimateSize=120). After items render, the
  // virtualizer remeasures and the actual `getTotalSize()` jumps
  // (a 40-line markdown message lays out at ~600px, a 120-line
  // message with a CodeMirror block at 2400px+). The effect didn't
  // refire on remeasure, so `scrollTop = scrollHeight_estimate`
  // landed hundreds of px above `scrollHeight_actual` and the chat
  // drifted up.
  //
  // ResizeObserver fixes this because it fires on every actual
  // size change of `contentRef` — both the initial estimate-based
  // commit AND each subsequent remeasure pass. The original removal
  // comment claimed RO "ran on every render (incl. unrelated 1Hz
  // ticks)"; that concern applied to a too-broad `useEffect` dep
  // array, not RO, which only delivers entries when the box model
  // actually changes.
  //
  // Wired via a callback ref instead of `contentRef.current` inside
  // `useLayoutEffect` because the content div is conditionally
  // rendered (the empty-state path returns early without it), so a
  // dep-array effect that ran before any messages existed would
  // capture `null` and never re-attach when the populated layout
  // finally mounted. The callback ref fires exactly when the DOM
  // node attaches/detaches, regardless of which render branch
  // produced it.
  //
  // Same gating as `pinToBottom`: skip while older history is
  // loading (head-anchor effect below owns scroll) or while a
  // tail-jump is in flight, and let `pinToBottom`'s own
  // `userScrolledRef` short-circuit handle deliberate scroll-up.
  const pinGateRef = useRef({
    isLoadingOlder: false,
    isLoadingNewer: false,
    hasMoreNewer: false,
  });
  pinGateRef.current = { isLoadingOlder, isLoadingNewer, hasMoreNewer };
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const setContentRef = useCallback(
    (el: HTMLDivElement | null) => {
      contentRef.current = el;
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (el) {
        const ro = new ResizeObserver(() => {
          const g = pinGateRef.current;
          if (g.isLoadingOlder || g.isLoadingNewer || g.hasMoreNewer) return;
          pinToBottom();
        });
        ro.observe(el);
        resizeObserverRef.current = ro;
      }
    },
    [pinToBottom],
  );

  // Scroll restoration across window mutations. Anchors the head end
  // via messages[0].id so both prepend (head grew) and head-eviction
  // (head shrank) get the same delta correction.
  const prevScrollHeightRef = useRef(0);
  const prevTopIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const newTopId = messages[0]?.id ?? null;
    const heightDelta = el.scrollHeight - prevScrollHeightRef.current;
    if (
      prevScrollHeightRef.current > 0 &&
      heightDelta !== 0 &&
      !suppressScrollRef.current
    ) {
      if (isLoadingOlder || prevTopIdRef.current !== newTopId) {
        suppressScrollRef.current = true;
        el.scrollTop = Math.max(0, el.scrollTop + heightDelta);
        requestAnimationFrame(() => {
          suppressScrollRef.current = false;
        });
      }
    }
    prevScrollHeightRef.current = el.scrollHeight;
    prevTopIdRef.current = newTopId;
  }, [messages, isLoadingOlder, isLoadingNewer]);

  // Hysteresis thresholds for the auto-follow detach / re-engage.
  //
  // The old handler used a single 60px threshold to flip the ref in
  // both directions, which raced with layout growth: every
  // programmatic pinToBottom would briefly land `distFromBottom = 0`,
  // but if a ResizeObserver callback grew the content again before
  // the browser's scroll event reached us, the handler saw
  // `distFromBottom > 60`, declared "user scrolled up," and froze
  // auto-follow. Symptom: the chat kept drifting above the live
  // messages while streaming.
  //
  // Two thresholds + a dead zone fix it:
  //   - distFromBottom > 200 → definitely the user scrolled up on
  //     purpose. Disengage.
  //   - distFromBottom < 20  → snapped back to bottom. Re-engage.
  //   - 20–200               → no state change (growth slack / fling).
  const UNFOLLOW_THRESHOLD_PX = 200;
  const REFOLLOW_THRESHOLD_PX = 20;
  const LOAD_MORE_THRESHOLD = 200;
  const handleScroll = useCallback(() => {
    if (suppressScrollRef.current) return;
    const el = listRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom > UNFOLLOW_THRESHOLD_PX) {
      userScrolledRef.current = true;
    } else if (distFromBottom < REFOLLOW_THRESHOLD_PX) {
      userScrolledRef.current = false;
    }
    if (el.scrollTop < LOAD_MORE_THRESHOLD && hasMoreOlder && !isLoadingOlder) {
      void loadOlderMessages();
    }
    if (
      distFromBottom < LOAD_MORE_THRESHOLD &&
      hasMoreNewer &&
      !isLoadingNewer
    ) {
      void loadNewerMessages();
    }
  }, [
    hasMoreOlder,
    isLoadingOlder,
    loadOlderMessages,
    hasMoreNewer,
    isLoadingNewer,
    loadNewerMessages,
  ]);

  // `/clear` wipes the chat history *in place* — same sessionId, same worktree,
  // same indexes — avoiding the re-init cost (worktree provisioning, codebase-
  // index banner, dev-server restart) that startNewChat pays. Shared by the
  // send-handler (typed "/clear" + Enter) and the slash-popup command dispatch.
  const clearChat = useCallback(() => {
    setInput('');
    setAttachments([]);
    void clearMessages();
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [clearMessages]);

  // Dispatch a built-in slash command picked from the popup (`onRunCommand`).
  const handleRunCommand = useCallback(
    (name: string) => {
      if (name === 'clear') clearChat();
    },
    [clearChat],
  );

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    const hasAttachments = attachments.length > 0;
    if (!trimmed && !pendingSkill && !hasAttachments) return;
    // Local command: typed `/clear` + Enter runs the same in-place wipe as the
    // slash-popup pick (see clearChat).
    if (trimmed === '/clear' && !pendingSkill) {
      clearChat();
      return;
    }
    if (trimmed) history.push(trimmed);
    // Mid-turn injection: when a turn is already running, fire the
    // message at the server anyway. The session's `pendingUserMessages`
    // queue holds it and `drainPendingUserMessagesIntoHistory` injects
    // it into the in-flight turn's history between iterations, so the
    // model picks it up on its very next LLM round instead of waiting
    // for the whole turn to finish.
    if (hasMoreNewer) {
      void jumpToTail().then(() => { pinToBottom(); });
    }
    void sendMessage(trimmed, hasAttachments ? attachments : undefined);
    setInput('');
    setAttachments([]);
    userScrolledRef.current = false;
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [
    input,
    attachments,
    pendingSkill,
    sendMessage,
    clearChat,
    hasMoreNewer,
    jumpToTail,
    pinToBottom,
    history,
  ]);

  const handleStop = useCallback(() => {
    stopGeneration();
  }, [stopGeneration]);

  // Global keyboard shortcuts for pending permissions. Cmd/Ctrl+Enter
  // approves the topmost pending request; Cmd/Ctrl+Shift+A allows every
  // tool for the rest of the session (wired to skipAllPermissions). We
  // gate on pendingPermissions.length so normal typing in the textarea
  // is never intercepted.
  useEffect(() => {
    if (pendingPermissions.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const next = pendingPermissions[0];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access can be undefined at runtime (noUncheckedIndexedAccess is off)
        if (next) void approvePermission(next, e.shiftKey);
      } else if (e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        void skipAllPermissions();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [pendingPermissions, approvePermission, skipAllPermissions]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (history.onKeyDown(e as React.KeyboardEvent<HTMLTextAreaElement>))
        return;
      if (e.key === 'Escape' && isStreaming) {
        e.preventDefault();
        handleStop();
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, handleStop, isStreaming, history],
  );

  // Loading state for resumed sessions — until the snapshot lands we
  // don't know the session's real model, mode, or transcript. Showing
  // the chat shell with the default model + empty transcript looks
  // like a valid blank session, which is misleading.
  if (isLoadingHistory) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          color: 'var(--text-secondary)',
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 11.5,
          letterSpacing: '0.04em',
        }}
      >
        Loading session…
      </div>
    );
  }

  // Axis selector JSX — passed to CodingAgentInputArea as a node so
  // both render branches (empty + streaming) get the same set of
  // dropdowns inline with Pull / Done. Closes over the full set of
  // selector handlers + state so the InputArea doesn't need any of
  // those props itself.
  // Server-composed dropdown label for the model axis. Empty string
  // for snapshots emitted before the field landed → falls back to the
  // ModelSelector's catalog-driven label.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty label string must fall back to undefined
  const modelDisplayLabel = sessionInfo?.modelDisplayLabel || undefined;

  const renderAxisSelector = (): React.ReactNode =>
    isChildSession ? null : (
      <>
        <AgentAxisSelector
          permission={permissionMode}
          model={modelMode}
          pattern={patternMode}
          // Any session can switch to any model (including the Claude
          // CLI), so the model dropdown is unrestricted (family defaults
          // to 'either' = all families). The claude-cli <-> ugly.bot
          // boundary is handled at switch time with a confirm + history
          // reset, not by hiding models here.
          //
          // `agent` still reflects the CURRENT backend so the permission
          // axis shows the right options (only claude-cli exposes
          // 'claude-plan').
          agent={
            model === 'claude-code' || model.startsWith('claude-code:')
              ? 'claude-code'
              : 'coding-agent'
          }
          onPermissionChange={(next) => {
            void setPermissionMode(next);
          }}
          onModelChange={(next) => {
            void setModelMode(next);
          }}
          onPatternChange={(next) => {
            void setPatternMode(next);
          }}
          onModelNeedsKey={handleModelNeedsKey}
          disabled={interactionDisabled}
          resolvedPattern={resolvedPattern}
          modelDisplayLabel={modelDisplayLabel}
        />
        <ReasoningSelector
          value={reasoningEffort}
          onChange={switchReasoningEffort}
          visible={supportsReasoningClient(model)}
          disabled={interactionDisabled}
        />
      </>
    );

  // Empty state — only render once we know the session is truly
  // empty. On a resumed session the `chatListMessages` backfill runs
  // asynchronously, so `messages` is briefly [] while history is in
  // flight; showing the splash then snapping to the transcript flashes
  // the UI.
  if (messages.length === 0 && !isStreaming) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          position: 'relative',
        }}
      >
        <CodebaseStatsModal
          open={codebaseStatsOpen}
          onClose={() => { setCodebaseStatsOpen(false); }}
          seed={codebaseReadiness ?? null}
        />
        <div className="panel-toolbar">
          {sessionInfo && <SessionReadout info={sessionInfo} model={model} />}
          <AutoRouteHint routing={autoModeRouting} />
          <div style={{ flex: 1 }} />
          {sessionInfo && (
            <ContextMeter
              data-id="context-meter-empty"
              info={sessionInfo}
              model={model}
              disabled={isStreaming}
              onClick={() => void compactNow()}
            />
          )}
          <CodebaseReadinessPill readiness={codebaseReadiness} onOpenStats={() => { setCodebaseStatsOpen(true); }} />
          {/* Session-id copy button removed per feedback (header was cluttered). */}
          {worktree && !sessionInfo?.title?.includes('finished') && (
            <button
              data-id="archive-session-empty"
              onClick={() => void handleArchiveSession()}
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- isStreaming is narrowed false in the empty-session block; kept identical to the active toolbar's button
              disabled={isStreaming || finishPipeline.running}
              style={{
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '2px 6px',
                cursor:
                  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- isStreaming is narrowed false in the empty-session block; kept identical to the active toolbar's button
                  isStreaming || finishPipeline.running
                    ? 'not-allowed'
                    : 'pointer',
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
              }}
              aria-label="Archive session"
              data-us-tooltip="Archive: move to the archived drawer (reversible). Worktree + branch are preserved."
            >
              <Archive size={14} />
            </button>
          )}
        </div>
        <PatternStrip
          pattern={resolvedPattern}
          currentStepId={currentStepId}
          currentStepIter={currentStepIter}
          currentStepFinished={currentStepFinished}
          patternMode={patternMode}
        />
        {showScratchpad && (
          <ScratchpadPanel
            entries={scratchpadEntries}
            onClose={() => { setShowScratchpad(false); }}
          />
        )}
        {error && (
          <div
            className="us-fade"
            style={{
              color: 'var(--error)',
              fontSize: 12,
              padding: '0 16px 8px',
            }}
          >
            {error}
          </div>
        )}
        {isChildSession ? (
          // Peer/child sessions are watch-only — no composer, no hero.
          <div style={{ flex: 1 }} />
        ) : (
          // Empty session → the new-session hero IS the empty state. Its
          // "Start" sends the first message to THIS session (it already
          // exists — main or an eagerly-created worktree session); it never
          // creates a second session.
          <NewSessionHero
            onStartCreation={(params) => void handleHeroSubmit(params)}
            onOpenSettings={handleHeroOpenSettings}
          />
        )}
      </div>
    );
  }

  return (
    <CwdContext.Provider value={sessionInfo?.cwd ?? ''}>
      {evalScorecardModalOpen && evalScorecardResult && (
        <EvalScorecardModal
          result={evalScorecardResult}
          onClose={() => { setEvalScorecardModalOpen(false); }}
        />
      )}
      <CodebaseStatsModal
        open={codebaseStatsOpen}
        onClose={() => { setCodebaseStatsOpen(false); }}
        seed={codebaseReadiness ?? null}
      />

      <div
        className="coding-chat-selectable"
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          // Flex child of the workspace `content` row — without minWidth:0 it won't
          // shrink to the viewport on mobile and the whole chat column (header,
          // messages, composer) overflows off the right edge.
          minWidth: 0,
          position: 'relative',
        }}
      >
        {showScratchpad && (
          <ScratchpadPanel
            entries={scratchpadEntries}
            onClose={() => { setShowScratchpad(false); }}
          />
        )}
        {/* Header strip — tokens + cost on the left, compaction +
          codebase + actions on the right. The Pull button lives here
          (next to the context meter) so the user-initiated worktree
          actions (pull / archive) cluster with session-level state.
          Done stays in the input toolbar with the axis dropdowns. */}
        <div className="panel-toolbar">
          {sessionInfo && <SessionReadout info={sessionInfo} model={model} />}
          <AutoRouteHint routing={autoModeRouting} />
          <div style={{ flex: 1 }} />
          {worktree?.parentBranch &&
            !isStreaming &&
            (() => {
              const parentBranch = worktree.parentBranch;
              const upToDate = worktreeBehind === 'up_to_date';
              const disabled = worktreeBlocked || pullInFlight || upToDate;
              const tooltip = pullInFlight
                ? 'Pulling…'
                : worktreeBlocked
                ? 'Resolve the current merge conflict first'
                : upToDate
                ? `Already up to date with ${parentBranch}`
                : `Pull from ${parentBranch}`;
              return (
                <button
                  data-id="pull-parent"
                  type="button"
                  onClick={() => void onPullParent()}
                  disabled={disabled}
                  title={tooltip}
                  style={{
                    background: disabled ? 'transparent' : 'var(--accent)',
                    color: disabled ? 'var(--text-muted)' : '#fff',
                    border: `1px solid ${
                      disabled ? 'var(--border)' : 'var(--accent)'
                    }`,
                    borderRadius: 4,
                    padding: '2px 8px',
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    opacity: disabled ? 0.6 : 1,
                  }}
                >
                  <GitMerge size={11} />
                  Pull
                </button>
              );
            })()}
          {sessionInfo && (
            <ContextMeter
              data-id="context-meter-active"
              info={sessionInfo}
              model={model}
              disabled={isStreaming}
              onClick={() => void compactNow()}
            />
          )}
          <CodebaseReadinessPill readiness={codebaseReadiness} onOpenStats={() => { setCodebaseStatsOpen(true); }} />
          {/* Session-id copy button removed per feedback (header was cluttered). */}
          {worktree && !sessionInfo?.title?.includes('finished') && (
            <button
              data-id="archive-session"
              onClick={() => void handleArchiveSession()}
              disabled={isStreaming || finishPipeline.running}
              style={{
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '2px 6px',
                cursor:
                  isStreaming || finishPipeline.running
                    ? 'not-allowed'
                    : 'pointer',
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
              }}
              aria-label="Archive session"
              data-us-tooltip="Archive: move to the archived drawer (reversible). Worktree + branch are preserved."
            >
              <Archive size={14} />
            </button>
          )}
          {pendingPermissions.length > 0 && (
            <button
              data-id="skip-all-permissions"
              onClick={() => void skipAllPermissions()}
              style={{
                background: 'transparent',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 10,
                color: 'var(--accent)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Allow All
            </button>
          )}
        </div>

        {/* Pattern engine state — second toolbar row, always present
          unless patternMode is 'none'. Renders a placeholder before
          the classifier resolves; step chips after. Read-only mirror
          of SessionSnapshot. Mounted in the streaming branch so it
          stays visible while the pattern engine drives steps. */}
        <PatternStrip
          pattern={resolvedPattern}
          currentStepId={currentStepId}
          currentStepIter={currentStepIter}
          currentStepFinished={currentStepFinished}
          patternMode={patternMode}
        />

        {/* Max-mode peer navigation row — visible whenever the parent
          session has live peers. Each pill is a quick shortcut to the
          peer's first-class session (also visible in the sidebar
          indented under the parent). Hidden when this chat panel is
          itself a peer (no children to surface). */}
        {!isChildSession && (
          <MaxModePeerPills
            peers={peerSessions ?? []}
            peerStuckState={peerStuckState}
            {...(sessionInfo?.maxModeWinnerSessionId
              ? { winnerCompositeId: sessionInfo.maxModeWinnerSessionId }
              : {})}
            {...(onOpenSession ? { onSelectPeer: onOpenSession } : {})}
          />
        )}

        {/* Per-peer live status — what each peer is currently running
          (last `tool_progress` line) + LSP error/warning rollups.
          Peer message text + tool calls themselves are interleaved
          into the main virtualizer below via `displayMessages`. */}
        {!isChildSession && (
          <PeerLiveStrip
            peers={peerSessions ?? []}
            peerToolProgress={peerToolProgress}
            peerLspState={peerLspState}
            peerStuckState={peerStuckState}
          />
        )}

        {/* Child-session banner — when this chat panel is itself a
          max-mode peer, surface a small strip with the parent's
          compositeId and a click-to-jump-up affordance. The prompt
          input + axis controls are disabled too (see
          `interactionDisabled`); the user is meant to *watch* the
          peer's run, not interact with it. */}
        {isChildSession && sessionInfo?.parentSessionId && (
          <div
            data-id="child-session-banner"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '6px 12px',
              borderBottom: '1px solid var(--border)',
              background:
                'color-mix(in srgb, var(--accent) 8%, var(--bg-secondary) 30%)',
              fontSize: 11,
              color: 'var(--text-secondary)',
            }}
          >
            <span>
              Max-mode peer ·{' '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>{model}</span> ·
              orchestrator owns this turn
            </span>
            {onOpenSession && (
              <button
                data-id="open-parent-session"
                onClick={() =>
                  { onOpenSession(sessionInfo.parentSessionId!); }
                }
                style={{
                  background: 'transparent',
                  border: '1px solid var(--accent)',
                  borderRadius: 4,
                  padding: '2px 8px',
                  color: 'var(--accent)',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                ↑ Open parent
              </button>
            )}
          </div>
        )}

        {/* Worktree status banner. Shown for conflict (blocks Send) and
          for non-blocking advisories (lost / unavailable / refresh_failed). */}
        {worktreeStatus &&
          worktreeStatus.kind !== 'refreshed' &&
          worktreeStatus.kind !== 'created' &&
          worktreeStatus.kind !== 'removed' && (
            <div
              style={{
                padding: '6px 10px',
                fontSize: 12,
                background:
                  worktreeStatus.kind === 'refresh_conflict'
                    ? 'rgba(239, 68, 68, 0.12)'
                    : 'var(--bg-secondary)',
                borderBottom: '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}
            >
              {worktreeStatus.kind === 'refresh_conflict' ? (
                <>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    Parent branch has conflicting changes. AI is resolving…
                  </div>
                  {worktreeStatus.conflicts &&
                    worktreeStatus.conflicts.length > 0 && (
                      <div
                        style={{
                          color: 'var(--text-muted)',
                          marginBottom: 6,
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                        }}
                      >
                        {worktreeStatus.conflicts.map((f) => (
                          <div key={f}>{f}</div>
                        ))}
                      </div>
                    )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      data-id="refresh-worktree"
                      onClick={() => void refreshWorktreeNow()}
                      style={{
                        background: 'transparent',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11,
                        cursor: 'pointer',
                      }}
                      title="Re-check: maybe the conflict already resolved"
                    >
                      Re-check
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ color: 'var(--text-muted)' }}>
                  {worktreeStatus.kind === 'lost' &&
                    'Worktree branch is gone; running against the main tree.'}
                  {worktreeStatus.kind === 'unavailable' &&
                    `Worktree unavailable: ${
                      worktreeStatus.message ?? 'unknown reason'
                    }`}
                  {worktreeStatus.kind === 'refresh_failed' &&
                    `Worktree refresh had issues: ${
                      worktreeStatus.message ?? 'unknown'
                    }`}
                  {worktreeStatus.kind === 'reattached' &&
                    'Worktree re-attached after resume.'}
                </div>
              )}
            </div>
          )}

        {latestTodos && (
          <PinnedTodos todos={latestTodos} isStreaming={isStreaming} />
        )}

        {/* Messages */}
        <div
          ref={listRef}
          data-id="chat-messages-list"
          onScroll={handleScroll}
          style={{
            flex: 1,
            overflowY: 'scroll',
            overflowX: 'hidden',
            padding: '8px 0',
            scrollbarGutter: 'stable',
          }}
        >
          {hasMoreOlder && (
            <div
              style={{
                padding: '8px 16px',
                textAlign: 'center',
                opacity: 0.5,
                fontSize: 12,
              }}
            >
              {isLoadingOlder ? 'Loading older messages…' : ''}
            </div>
          )}
          {isResumed && <ResumeBanner info={sessionInfo} />}

          <div
            ref={setContentRef}
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((vRow) => {
              const i = vRow.index;
              const msg = displayMessages[i];
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access can be undefined at runtime (noUncheckedIndexedAccess is off)
              if (!msg) return null;
              // Turn-end / todo snapshot logic is parent-only (peer
              // turns are run by the orchestrator, not the user) — gate
              // on `!msg.peerModelId` so a peer assistant message never
              // claims a parent turn boundary.
              const turnEnded =
                !msg.peerModelId &&
                msg.role === 'assistant' &&
                !msg.content.includes(TERMINATED_MARKER_CLIENT) &&
                (displayMessages[i + 1]?.role === 'user' ||
                  (i === displayMessages.length - 1 && !isStreaming));
              let snapshot: TodoItem[] | null = null;
              if (turnEnded) {
                let turnStart = 0;
                for (let k = i - 1; k >= 0; k--) {
                  if (displayMessages[k]?.role === 'user') {
                    turnStart = k + 1;
                    break;
                  }
                }
                snapshot = findTurnTodos(displayMessages, turnStart, i);
              }
              let body: ReactNode;
              if (msg.role === 'judge') {
                body = <JudgeCard msg={msg} />;
              } else if (msg.role === 'status') {
                body = (
                  <DoneCard
                    msg={msg}
                    controls={{
                      isLatest: msg.id === latestStatusId,
                      finishPipeline,
                      worktreeParentBranch: worktree?.parentBranch ?? null,
                      showArchivePrompt,
                      dirtyMainPrompt,
                      reviewModal,
                      failurePopup,
                      onRunFinish: () => void runFinish(),
                      onStopStage: (stage) => void stopFinishStage(stage),
                      onResolveDirtyMain: resolveDirtyMainPrompt,
                      onAcceptReview: (cm) => void handleReviewAccept(cm),
                      onRejectReview: handleReviewReject,
                      onCloseFailure: () => { setFailurePopup(null); },
                      onSkipGate: skipFailedStage,
                      onArchive: () => void handleArchiveSession(),
                      onDismissArchive: () => { setShowArchivePrompt(false); },
                    }}
                  />
                );
              } else if (
                msg.role === 'user' &&
                msg.content.includes(CRITIQUE_MARKER_CLIENT)
              ) {
                body = (
                  <JudgeNudgeCard
                    msg={msg}
                    index={critiqueGroupIndex[i]}
                    total={critiqueGroupTotal[i]}
                  />
                );
              } else if (
                msg.role === 'user' &&
                msg.content.includes(REPLAN_MARKER_CLIENT)
              ) {
                body = <HarnessReplanBubble msg={msg} />;
              } else if (
                msg.role === 'assistant' &&
                msg.content.includes(TERMINATED_MARKER_CLIENT)
              ) {
                body = (
                  <JudgeTerminatedCard
                    msg={msg}
                    onPickOption={(text) => void sendMessage(text)}
                  />
                );
              } else if (msg.role === 'user') {
                body = <UserMessage msg={msg} />;
              } else {
                body = (
                  <Fragment>
                    <AssistantMessage
                      msg={msg}
                      checkpointsEnabled={features.checkpoints}
                      onRestoreCheckpoint={restoreCheckpoint}
                      onStopTool={stopTool}
                      sessionIsStreaming={isStreaming}
                    />
                    {snapshot && (
                      <div style={{ padding: '0 16px' }}>
                        <TodoCard todos={snapshot} isStreaming={false} />
                      </div>
                    )}
                  </Fragment>
                );
              }
              // Peer-tagged rows get a small model badge above the
              // bubble so the user can tell whose voice they're seeing
              // when parent + every peer's transcript are interleaved
              // chronologically. Plus a faint left rail so peer rows
              // are scannable as a separate "voice" group.
              const peerModelId = msg.peerModelId;
              const wrapped = peerModelId ? (
                <div
                  style={{
                    position: 'relative',
                    borderLeft:
                      '2px solid color-mix(in srgb, var(--accent) 40%, transparent)',
                    marginLeft: 6,
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9.5,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      color: 'var(--accent)',
                      padding: '2px 0 2px 12px',
                      whiteSpace: 'nowrap',
                    }}
                    title={`Max-mode peer · ${peerModelId}`}
                  >
                    {peerModelId}
                  </div>
                  {body}
                </div>
              ) : (
                body
              );
              return (
                <div
                  key={vRow.key}
                  data-index={i}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vRow.start}px)`,
                    paddingBottom: 6,
                  }}
                >
                  {wrapped}
                </div>
              );
            })}
          </div>

          {hasMoreNewer && (
            <div
              style={{
                padding: '8px 16px',
                textAlign: 'center',
                opacity: 0.5,
                fontSize: 12,
              }}
            >
              {isLoadingNewer ? 'Loading newer messages…' : ''}
            </div>
          )}

          {/* AskUserCard intentionally NOT rendered here — it lives outside
            the scroll container so it stays pinned above the composer
            even when the message list scrolls. See the sibling block
            after this scrollable div. */}

          {!serverHealthy && (
            <div className="us-fade-up" style={{ padding: '4px 16px' }}>
              <div
                style={{
                  background: 'rgba(227,18,11,0.1)',
                  border: '1px solid var(--error)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 12,
                  color: 'var(--error)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <CircleDot size={12} />
                <span>
                  Agent server unreachable — restart the IDE or check the
                  sidecar logs.
                </span>
              </div>
            </div>
          )}

          {pendingPermissions.map((perm) => (
            <PermissionCard
              key={perm.id}
              perm={perm}
              onApprove={() => void approvePermission(perm)}
              onApproveAll={() => void approvePermission(perm, true)}
            />
          ))}

          {error && (
            <div className="us-fade-up" style={{ padding: '4px 16px' }}>
              <div
                style={{
                  background: 'rgba(227,18,11,0.1)',
                  border: '1px solid var(--error)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 12,
                  color: 'var(--error)',
                }}
              >
                {error}
              </div>
            </div>
          )}
        </div>

        {/* Pinned ask_user strip — sibling of the scrollable message list
          and the composer, so it stays visible regardless of scroll
          position. Renders only the OLDEST entry in the queue; once
          answered, the next-oldest takes its place. The "+N more"
          hint inside the card surfaces queue depth.

          Peer cards (sessionId !== this session) get a small chip
          labeled with the peer model id, looked up from peerSessions
          (max-mode parents) or fall back to a generic "Peer" label
          when the model id can't be resolved. */}
        {pendingAskUsers.length > 0 &&
          (() => {
            const head = pendingAskUsers[0];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access can be undefined at runtime (noUncheckedIndexedAccess is off)
            if (!head) return null;
            const isPeer = head.sessionId !== sessionId;
            const peerModel = isPeer
              ? peerSessions?.find((p) => p.compositeId === head.sessionId)
                  ?.model ?? 'Peer'
              : undefined;
            return (
              <div style={{ flexShrink: 0 }}>
                <AskUserCard
                  pending={head}
                  onAnswer={answerAskUser}
                  {...(peerModel ? { peerLabel: peerModel } : {})}
                  queueDepth={pendingAskUsers.length}
                />
              </div>
            );
          })()}

        {/* Step-review gates between SPEC/DIAGNOSE and BUILD/FIX. The
          spec/diagnosis itself renders in its tab; this strip is just
          approve/iterate. Render head-only for now — patterns can
          only have one paused step at a time per session. */}
        {pendingStepReviews.length > 0 &&
          (() => {
            const head = pendingStepReviews[0];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index access can be undefined at runtime (noUncheckedIndexedAccess is off)
            if (!head) return null;
            return (
              <div style={{ flexShrink: 0 }}>
                <StepReviewCard pending={head} onAnswer={answerStepReview} />
              </div>
            );
          })()}

        {/* Dirty-main confirm + review-changes + failure popup are no
          longer rendered as floating modals — they fold into the
          latest "Done entry" `DoneCard` inline (see virtualizer
          dispatch above). */}

        {/* Eval-mode strip: scorecard (when graded) + Grade-run button
          (when the agent has finished every task turn but not yet
          graded). Sits above the input so it's visible whether or not
          the user has scrolled the message list. The scorecard itself
          is persisted server-side on the session's `eval.json`, so it
          re-renders on app restart from the session snapshot. */}
        {evalState && (
          <div style={{ padding: '0 12px' }}>
            {evalScorecardResult && (
              <div
                data-id="eval-scoreboard-strip"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '10px 12px',
                  margin: '8px 0',
                  background: 'var(--bg-secondary)',
                  border: `1px solid ${
                    (evalScorecardResult.score ?? 0) >=
                    (evalScorecardResult.scoreMax ?? 0)
                      ? '#3a8c4a'
                      : 'var(--accent)'
                  }`,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--font-label)',
                      fontSize: 10,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      fontWeight: 700,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Eval graded
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                    {evalScorecardResult.taskName}
                    {typeof evalScorecardResult.score === 'number' &&
                    typeof evalScorecardResult.scoreMax === 'number' ? (
                      <span
                        style={{
                          marginLeft: 8,
                          color: 'var(--text-secondary)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {evalScorecardResult.score} /{' '}
                        {evalScorecardResult.scoreMax}
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setEvalScorecardModalOpen(true); }}
                  data-id="eval-show-scoreboard-button"
                  style={{
                    fontFamily: 'var(--font-label)',
                    fontSize: 11,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    fontWeight: 700,
                    color: 'var(--accent)',
                    background: 'transparent',
                    border: '1px solid var(--accent)',
                    padding: '6px 12px',
                    cursor: 'pointer',
                  }}
                >
                  Show scoreboard
                </button>
              </div>
            )}
            {!evalScorecardResult && evalAllTurnsDone && (
              <div
                data-id="eval-grade-strip"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '10px 12px',
                  margin: '8px 0',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--accent)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--font-label)',
                      fontSize: 10,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      fontWeight: 700,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Eval task complete
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: 'var(--text-primary)',
                    }}
                  >
                    {evalState.taskName} — ready to grade.
                  </div>
                  {evalGradeError && (
                    <div style={{ color: '#FF5500', fontSize: 12 }}>
                      {evalGradeError}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleGradeEval()}
                  disabled={evalGrading}
                  data-id="eval-grade-button"
                  style={{
                    fontFamily: 'var(--font-label)',
                    fontSize: 11,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    fontWeight: 800,
                    color: '#ffffff',
                    background: evalGrading
                      ? 'var(--border)'
                      : 'linear-gradient(135deg, #FF8041 0%, #FF5500 50%, #E63900 100%)',
                    border: '1px solid var(--accent)',
                    padding: '8px 14px',
                    cursor: evalGrading ? 'not-allowed' : 'pointer',
                    opacity: evalGrading ? 0.6 : 1,
                  }}
                >
                  {evalGrading ? 'Grading…' : 'Grade run'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Input — hidden on child sessions (the orchestrator parent
          owns the turn loop; users open the peer to watch, not type).
          The four axis dropdowns (Permission · Model · Pattern ·
          Reason) live INSIDE the input area's toolbar row alongside
          Pull / Done — see `axisSelector` below. */}
        {isChildSession ? null : (
          <CodingAgentInputArea
            axisSelector={renderAxisSelector()}
            input={input}
            setInput={setInput}
            attachments={attachments}
            setAttachments={setAttachments}
            onSend={handleSend}
            onKeyDown={handleKeyDown}
            isStreaming={isStreaming}
            inputRef={inputRef}
            onStop={handleStop}
            permissionMode={permissionMode}
            pendingSkill={pendingSkill}
            onPendingSkillChange={setPendingSkill}
            onRunCommand={handleRunCommand}
            awaitingAskUser={
              pendingAskUsers.length > 0 || pendingStepReviews.length > 0
            }
            scratchpadCount={scratchpadEntries.length}
            showScratchpad={showScratchpad}
            onToggleScratchpad={
              sessionId ? () => { setShowScratchpad((v) => !v); } : undefined
            }
            readiness={codebaseReadiness}
          />
        )}
      </div>
    </CwdContext.Provider>
  );
}

// ── Input Area ──────────────────────────────────────────────────────

function CodingAgentInputArea({
  axisSelector,
  input,
  setInput,
  attachments,
  setAttachments,
  onSend,
  onKeyDown,
  isStreaming,
  inputRef,
  onStop,
  permissionMode,
  pendingSkill,
  onPendingSkillChange,
  onRunCommand,
  awaitingAskUser = false,
  scratchpadCount = 0,
  showScratchpad = false,
  onToggleScratchpad,
  readiness,
}: {
  /**
   * Permission · Model · Pattern · Reason dropdowns supplied by the
   * parent so the user sees the routing context next to where they're
   * composing. Rendered as the first item in the toolbar row, sharing
   * the line with Done / Thinking. Pass `null` to suppress (e.g. on
   * child / peer sessions where the parent owns the orchestration
   * knobs).
   */
  axisSelector?: React.ReactNode;
  input: string;
  setInput: (v: string) => void;
  /** Pending image attachments staged in the composer. */
  attachments: {
    kind: 'image';
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    base64: string;
    filename?: string;
  }[];
  setAttachments: React.Dispatch<
    React.SetStateAction<
      {
        kind: 'image';
        mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
        base64: string;
        filename?: string;
      }[]
    >
  >;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  isStreaming: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onStop?: () => void;
  permissionMode: 'edit' | 'yolo' | 'claude-plan' | undefined;
  pendingSkill: string | null;
  onPendingSkillChange: (skill: string | null) => void;
  /** Run a built-in slash command (e.g. `/clear`) picked from the popup. */
  onRunCommand?: (name: string) => void;
  /** When true, disable the textarea and send button because the agent is waiting on an ask_user answer. */
  awaitingAskUser?: boolean;
  scratchpadCount?: number;
  showScratchpad?: boolean;
  onToggleScratchpad?: () => void;
  /**
   * Codebase-readiness snapshot pushed via `session_state`. Pulled
   * out of `useCodingAgentChat` and threaded down so the strip is
   * driven by server-side push instead of client-side polling.
   */
  readiness:
    | import('../shared/api').SessionSnapshot['codebaseReadiness']
    | null;
}) {
  const handleSlashSelect = useCallback(
    (skill: Skill) => {
      const action = resolveSlashSelection(skill);
      if (action.type === 'run-command') {
        // Built-in commands run on select — never write "/clear" back into the
        // input (it re-matches the slash trigger and reopens the popup, which is
        // the bug that made `/clear` impossible to complete). Clear the partial
        // query and hand off to the panel's command dispatcher.
        setInput('');
        onRunCommand?.(action.name);
      } else {
        onPendingSkillChange(action.name);
        setInput('');
      }
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [setInput, onPendingSkillChange, onRunCommand, inputRef],
  );

  const slash = useSlashCommands({
    input,
    setInput,
    onSelect: handleSlashSelect,
  });

  // Auto-resize textarea — runs on every `input` change so programmatic
  // updates (history recall, slash command rewrites) also re-measure.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = String(Math.min(el.scrollHeight, 200)) + 'px';
  }, [input, inputRef]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInput(value);
      slash.handleChange(value);
    },
    [setInput, slash],
  );

  /**
   * Read a File into base64 + media type for inline transport.
   * Rejects non-image files and anything bigger than ~5 MB so a stray
   * paste of a giant photo doesn't blow the JSON RPC frame budget.
   */
  const ingestFiles = useCallback(
    async (files: FileList | File[]): Promise<void> => {
      const accepted: typeof attachments = [];
      const arr = Array.from(files);
      for (const f of arr) {
        if (!f.type.startsWith('image/')) continue;
        if (f.size > 5 * 1024 * 1024) {
          // eslint-disable-next-line no-alert
          alert(`Image "${f.name}" is over 5MB and was skipped.`);
          continue;
        }
        const mt = f.type;
        if (
          mt !== 'image/png' &&
          mt !== 'image/jpeg' &&
          mt !== 'image/webp' &&
          mt !== 'image/gif'
        ) {
          continue;
        }
        const buf = await f.arrayBuffer();
        // Convert ArrayBuffer → base64 in chunks; one big String.fromCharCode
        // call blows the JS stack on large images.
        const bytes = new Uint8Array(buf);
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        accepted.push({
          kind: 'image',
          mediaType: mt,
          base64: btoa(binary),
          filename: f.name || undefined,
        });
        if (accepted.length + attachments.length >= 5) break;
      }
      if (accepted.length === 0) return;
      setAttachments((prev) => [...prev, ...accepted].slice(0, 5));
    },
    [attachments.length, setAttachments],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- clipboardData can be null at runtime despite React's non-null type
      const files = e.clipboardData?.files;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- files may be undefined when clipboardData was null
      if (files && files.length > 0) {
        const hasImage = Array.from(files).some((f) =>
          f.type.startsWith('image/'),
        );
        if (hasImage) {
          e.preventDefault();
          void ingestFiles(files);
        }
      }
    },
    [ingestFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dataTransfer can be null at runtime despite React's non-null type
      const files = e.dataTransfer?.files;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- files may be undefined when dataTransfer was null
      if (files && files.length > 0) {
        const hasImage = Array.from(files).some((f) =>
          f.type.startsWith('image/'),
        );
        if (hasImage) {
          e.preventDefault();
          void ingestFiles(files);
        }
      }
    },
    [ingestFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only intercept image drags so the rest of the IDE's drag-drop
    // behavior stays unchanged.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dataTransfer can be null at runtime despite React's non-null type
    const types = e.dataTransfer?.types;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- types may be undefined when dataTransfer was null
    if (types && Array.from(types).includes('Files')) {
      e.preventDefault();
    }
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const removeAttachment = useCallback(
    (idx: number) => {
      setAttachments((prev) => prev.filter((_, i) => i !== idx));
    },
    [setAttachments],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (slash.handleKeyDown(e)) return;
      onKeyDown(e);
    },
    [slash, onKeyDown],
  );

  const canSend =
    !awaitingAskUser &&
    (input.trim().length > 0 ||
      pendingSkill !== null ||
      attachments.length > 0);
  const archActive = readiness?.architecture.status === 'building';
  const idxActive = readiness?.indexer.status === 'indexing';
  const codebaseAnalysisActive = archActive || idxActive;
  const placeholder = awaitingAskUser
    ? 'Agent is waiting on your answer above\u2026'
    : pendingSkill
    ? ''
    : codebaseAnalysisActive
    ? 'Codebase analysis running \u2014 AI coding quality will be reduced until it finishes'
    : isStreaming
    ? `Thinking\u2026 type to inject mid-turn (Esc to stop, ${shortcut(
        'Enter',
      )} to send)`
    : `Message agent\u2026 (${shortcut('Enter')} to send)`;

  return (
    <div
      style={{
        // The workspace root owns the bottom safe-area inset (single source of
        // truth), so the composer keeps plain padding to avoid double-counting.
        padding: '8px 12px',
        boxSizing: 'border-box',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-panel)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
          minWidth: 0,
          // The four axis dropdowns sit at the head of this row; on a
          // narrow panel they'd otherwise wrap onto a second line and
          // push everything (Pull / Done / Build / Thinking /
          // Scratchpad / Done-button) below the textarea. Forcing
          // nowrap + horizontal overflow keeps the row stable and
          // anchored to the textarea.
          flexWrap: 'nowrap',
          overflowX: 'auto',
        }}
      >
        {axisSelector}
        <SandboxStatusPill permissionMode={permissionMode} />
        {/* Done button moved into the inline `DoneCard` rendered for
          every `role: 'status'` message — see DoneCard in this file
          and `appendDoneEntry` server-side. The latest done entry is
          where the user clicks Done now; the toolbar stays clean. */}
        <div style={{ flex: 1 }} />
        {scratchpadCount > 0 && onToggleScratchpad && (
          <button
            data-id="toggle-scratchpad"
            onClick={onToggleScratchpad}
            style={{
              background: 'none',
              border: 'none',
              color: showScratchpad ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer',
              padding: '2px 6px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              position: 'relative',
              flexShrink: 0,
            }}
            title="Scratchpad notes"
          >
            <StickyNote size={15} />
            <span
              style={{
                position: 'absolute',
                top: -2,
                right: -2,
                background: 'var(--accent)',
                color: '#fff',
                borderRadius: '50%',
                width: 14,
                height: 14,
                fontSize: 9,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 600,
              }}
            >
              {scratchpadCount}
            </span>
          </button>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        {slash.popupOpen && (
          <SlashCommandPopup
            items={slash.filtered}
            selectedIdx={slash.selectedIdx}
            onHover={slash.setSelectedIdx}
            onSelect={(skill) => {
              slash.close();
              handleSlashSelect(skill);
            }}
          />
        )}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '6px 10px',
          }}
        >
          {/* Codebase readiness moved out of the input area into a
              compact pill in the panel header next to ContextMeter —
              full architecture / index status surfaces via tooltip on
              hover. See `CodebaseReadinessPill`. */}
          {attachments.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
              }}
            >
              {attachments.map((a, i) => (
                <div
                  key={i}
                  style={{
                    position: 'relative',
                    width: 48,
                    height: 48,
                    borderRadius: 6,
                    overflow: 'hidden',
                    border: '1px solid var(--border)',
                  }}
                  title={a.filename ?? `attachment-${i}`}
                >
                  <img
                    src={`data:${a.mediaType};base64,${a.base64}`}
                    alt={a.filename ?? `attachment-${i}`}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                  <button
                    data-id="remove-attachment"
                    onClick={() => { removeAttachment(i); }}
                    title="Remove"
                    style={{
                      position: 'absolute',
                      top: 1,
                      right: 1,
                      width: 16,
                      height: 16,
                      borderRadius: '50%',
                      border: 'none',
                      background: 'rgba(0,0,0,0.6)',
                      color: '#fff',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                    }}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
            }}
          >
            {pendingSkill && (
              <SkillPill
                name={pendingSkill}
                onRemove={() => { onPendingSkillChange(null); }}
              />
            )}
            {isStreaming && (
              <Loader2
                size={13}
                className="us-spin"
                aria-label="Thinking"
                style={{ color: 'var(--accent)', flexShrink: 0 }}
              />
            )}
            <input
              data-id="file-input"
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const fs = e.target.files;
                if (fs && fs.length > 0) void ingestFiles(fs);
                e.target.value = '';
              }}
            />
            <button
              data-id="attach-file"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={awaitingAskUser || attachments.length >= 5}
              title={
                attachments.length >= 5
                  ? 'Max 5 images per message'
                  : 'Attach image (or paste / drop)'
              }
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor:
                  awaitingAskUser || attachments.length >= 5
                    ? 'not-allowed'
                    : 'pointer',
                padding: 2,
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
                opacity: attachments.length >= 5 ? 0.4 : 1,
              }}
            >
              <Paperclip size={14} />
            </button>
            <textarea
              data-id="chat-input"
              ref={inputRef}
              value={input}
              onChange={handleChange}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Backspace' && input === '' && pendingSkill) {
                  e.preventDefault();
                  onPendingSkillChange(null);
                  return;
                }
                handleKeyDown(e);
              }}
              onBlur={slash.close}
              placeholder={placeholder}
              rows={1}
              disabled={awaitingAskUser}
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                resize: 'none',
                fontFamily: 'inherit',
                fontSize: 13,
                color: 'var(--text-primary)',
                lineHeight: 1.5,
                maxHeight: 200,
                overflowY: 'auto',
                opacity: awaitingAskUser ? 0.5 : 1,
                cursor: awaitingAskUser ? 'not-allowed' : 'text',
              }}
            />
            {(() => {
              // Single action button: Send icon when idle or when the user
              // has typed something (mid-turn injection lands the message
              // in the current turn); Stop icon only when streaming with
              // an empty input.
              const showStop =
                isStreaming && input.trim().length === 0 && !!onStop;
              if (showStop) {
                return (
                  <button
                    data-id="stop-generation"
                    onClick={onStop}
                    title="Stop"
                    style={{
                      background: 'var(--error)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      width: 28,
                      height: 28,
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    <Square size={12} fill="#fff" />
                  </button>
                );
              }
              const active = canSend;
              const title = isStreaming ? 'Queue message' : 'Send';
              return (
                <button
                  data-id="chat-send"
                  onClick={onSend}
                  disabled={!active}
                  title={title}
                  style={{
                    background: active
                      ? 'var(--accent)'
                      : 'var(--bg-secondary)',
                    color: active ? '#fff' : 'var(--text-muted)',
                    border: 'none',
                    borderRadius: 6,
                    width: 28,
                    height: 28,
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: active ? 'pointer' : 'default',
                    flexShrink: 0,
                  }}
                >
                  <Send size={13} />
                </button>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Modal wrapper around `EvalScorecard`. Backdrop click + Escape close.
 * The scorecard already paints its own pass/fail border + the ✕ next
 * to the score (via the `onClose` prop), so the modal frame itself is
 * frameless — just the dim+blur backdrop holds the centered card.
 */
function EvalScorecardModal({
  result,
  onClose,
}: {
  result: import('../shared/api').EvalGradeResult;
  onClose: () => void;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div
      data-id="popup-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(5,6,9,0.72)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(16px, 5vw, 40px)',
      }}
    >
      <div
        data-id="popup-content"
        onClick={(e) => { e.stopPropagation(); }}
        style={{
          width: 'min(720px, 100%)',
          maxHeight: '90vh',
          overflow: 'auto',
        }}
      >
        <EvalScorecard result={result} onClose={onClose} />
      </div>
    </div>
  );
}

// React.memo so that parent re-renders triggered purely by sibling state
// (e.g. a SessionLayout width drag) skip reconciliation of the entire
// chat tree — historically the dominant cost of resize jank, since long
// sessions render hundreds of message nodes. Default shallow prop
// comparison is sufficient because the parent passes stable callback
// refs (see SessionLayout.handleSessionCreated / handleTitleChanged /
// handleModelChangedNoop).
const CodingAgentChatMemo = memo(CodingAgentChatInner);

export function CodingAgentChat(props: CodingAgentChatProps = {}) {
  return (
    <ChatOpenUriProvider value={props.onOpenUri}>
      <CodingAgentChatMemo {...props} />
    </ChatOpenUriProvider>
  );
}

type SandboxStatus = Awaited<ReturnType<typeof native.sandbox.status>>;

/** Resolve the open project's id (from `.uglyapp`) + dir for sandbox calls. */
async function resolveProjectInfo(): Promise<{ projectId: string | null; projectDir: string | null }> {
  const projectDir = getActiveProjectPath();
  if (!projectDir) return { projectId: null, projectDir: null };
  try {
    const ua = JSON.parse(await native.fs.readFile(projectDir + '/.uglyapp')) as { projectId?: string };
    return { projectId: ua.projectId ?? null, projectDir };
  } catch {
    return { projectId: null, projectDir };
  }
}

function SandboxStatusPill({
  permissionMode,
}: {
  permissionMode: 'edit' | 'yolo' | 'claude-plan' | undefined;
}) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    void (async () => {
      const info = await resolveProjectInfo();
      setProjectId(info.projectId);
      setProjectDir(info.projectDir);
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      setStatus(await native.sandbox.status(projectId));
    } catch (err) {
      console.warn('[sandbox] status failed:', err);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sandbox is irrelevant for 'yolo' (no enforcement) and
  // 'claude-plan' (claude-cli's own plan mode handles writes).
  if (
    permissionMode === 'yolo' ||
    permissionMode === 'claude-plan' ||
    !projectId ||
    !status?.supported
  )
    return null;
  if (status.initialized) return null;

  const onInit = async () => {
    if (!projectId || !projectDir || working) return;
    setWorking(true);
    try {
      // Triggers the OS admin-elevation prompt (Touch ID / password) in the
      // daemon, then creates the per-project sandbox user + ACLs.
      const r = await native.sandbox.initialize(projectId, projectDir);
      if (r.ok) await refresh();
      else console.warn('[sandbox] init failed:', r.error);
    } catch (err) {
      console.warn('[sandbox] init threw:', err);
    } finally {
      setWorking(false);
    }
  };

  return (
    <button
      data-id="init-session"
      onClick={() => void onInit()}
      disabled={working}
      title="bash and python_exec currently run without OS-level sandboxing. Click to create a per-project sandbox user (one-time admin prompt)."
      style={{
        fontSize: 10,
        padding: '2px 8px',
        borderRadius: 4,
        border: '1px solid var(--warning, #c77700)',
        background: 'transparent',
        color: 'var(--warning, #c77700)',
        cursor: working ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {working ? 'initializing\u2026' : 'sandbox off \u2014 initialize'}
    </button>
  );
}
