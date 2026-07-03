/**
 * Header button in CodingAgentChat that lets a user file an issue report for the
 * current coding session. On submit it writes ONE row to the app's errorLog D1 —
 * the SAME sink as a normal error (POST /api/errorLogCaptureNoAuth) — but carrying
 * the full session history (messages + settings) in `context`, so a session issue
 * sits alongside the agent's own task-error rows and can be analyzed together by
 * `compositeId`. (The old design bundled on-disk artifacts to R2 + emailed a
 * maintainer; this replaces that with a queryable errorLog row.)
 *
 * The parent passes `getBundle()` — it owns the live session state (messages,
 * model, reasoning/mode axes). We cap the serialized bundle so an enormous session
 * doesn't blow past the D1 row limit (keep the most-recent turns).
 */
import { Bug, Check } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

type IssueType = 'bug' | 'feature' | 'design';

const BUTTON_SIZE_PX = 28;
const POPUP_WIDTH = 340;
// Keep the serialized session bundle under this — D1 rows have a size ceiling and
// a report should stay a single row. Oldest turns are dropped first if it exceeds.
const MAX_BUNDLE_BYTES = 700_000;

/** Trim a bundle's `messages` (oldest-first) until the whole thing fits the cap. */
function capBundle(bundle: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(bundle).length <= MAX_BUNDLE_BYTES) return bundle;
  const msgs = Array.isArray(bundle['messages']) ? [...(bundle['messages'] as unknown[])] : [];
  const originalCount = msgs.length;
  let kept = msgs;
  while (kept.length > 1 &&
    JSON.stringify({ ...bundle, messages: kept }).length > MAX_BUNDLE_BYTES) {
    kept = kept.slice(Math.max(1, Math.ceil(kept.length / 10))); // drop oldest ~10%
  }
  return { ...bundle, messages: kept, _truncated: { originalCount, keptCount: kept.length } };
}

export function ReportSessionIssueButton({
  compositeId,
  getBundle,
}: {
  compositeId: string;
  /** Returns the live session state to attach (messages + settings). */
  getBundle?: () => Record<string, unknown>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [type, setType] = useState<IssueType>('bug');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef.current?.contains(t)) return;
      if (buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  function openPopover() {
    setOpen(true);
    setError(null);
    setDone(null);
    setMessage('');
    setType('bug');
  }

  async function handleSubmit(): Promise<void> {
    if (!message.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const reportId =
        'sir_' + (globalThis.crypto?.randomUUID?.().slice(0, 8) ?? String(Date.now()).slice(-8));
      const description = message.trim();
      const bundle = capBundle({
        compositeId,
        issueType: type,
        description,
        reportId,
        userAgent: navigator.userAgent,
        ...(getBundle ? getBundle() : {}),
      });
      // Write to the SAME errorLog D1 as a normal error (framework Logger sink),
      // with the whole session bundle in `context`. type='session-issue' so these
      // rows are filterable apart from ordinary console errors.
      const entry = {
        level: 'error',
        message: `[session-issue:${type}] ${description}`.slice(0, 8000),
        url: typeof location !== 'undefined' ? location.href : '',
        timestamp: Date.now(),
        source: 'session-issue',
        type: 'session-issue',
        context: bundle,
      };
      const res = await fetch('/api/errorLogCaptureNoAuth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ input: { entries: [entry] } }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `submit failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
        );
      }
      setDone(reportId);
      setTimeout(() => { setOpen(false); }, 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={buttonRef}
        type="button"
        data-id="report-session-issue-button"
        onClick={() => { if (open) { setOpen(false); } else { openPopover(); } }}
        aria-label="Report issue with session logs"
        data-us-tooltip="Report issue with full session logs"
        style={{
          width: BUTTON_SIZE_PX,
          height: BUTTON_SIZE_PX,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          color: 'var(--text-muted)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <Bug size={14} />
      </button>

      {open && (
        <div
          ref={popoverRef}
          style={{
            position: 'absolute',
            top: BUTTON_SIZE_PX + 6,
            right: 0,
            zIndex: 1100,
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 14,
            width: POPUP_WIDTH,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
            color: 'var(--text-primary)',
          }}
        >
          {done !== null ? (
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                color: '#22c55e',
                fontSize: 13,
              }}
            >
              <Check size={14} /> Report {done} sent.
            </div>
          ) : (
            <>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: 'var(--text-secondary)',
                  marginBottom: 6,
                }}
              >
                Report session issue
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  marginBottom: 10,
                  lineHeight: 1.4,
                }}
              >
                Logs this session&apos;s full history (all messages + settings) to
                the error log so it can be analyzed alongside the session&apos;s
                errors. Nothing leaves your error log.
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                {(['bug', 'feature', 'design'] as IssueType[]).map((t) => (
                  <button
                    key={t}
                    data-id={`report-session-issue-type-${t}`}
                    onClick={() => { setType(t); }}
                    style={{
                      flex: 1,
                      padding: '5px 8px',
                      borderRadius: 4,
                      border: `1px solid ${
                        type === t ? 'var(--accent)' : 'var(--border)'
                      }`,
                      background:
                        type === t
                          ? 'rgba(255, 85, 0, 0.10)'
                          : 'var(--bg-secondary)',
                      color:
                        type === t ? 'var(--accent)' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: 'capitalize',
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <textarea
                data-id="report-session-issue-message"
                autoFocus
                value={message}
                onChange={(e) => { setMessage(e.target.value); }}
                placeholder="What went wrong in this session?"
                rows={5}
                maxLength={5000}
                style={{
                  width: '100%',
                  borderRadius: 4,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  padding: 8,
                  fontSize: 13,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
              {error && (
                <div
                  style={{
                    marginTop: 8,
                    color: 'var(--error, #ef4444)',
                    fontSize: 11,
                    lineHeight: 1.4,
                  }}
                >
                  {error}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  data-id="report-session-issue-cancel"
                  type="button"
                  onClick={() => { setOpen(false); }}
                  style={{
                    flex: 1,
                    padding: '6px 10px',
                    borderRadius: 4,
                    border: '1px solid var(--border)',
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  Cancel
                </button>
                <button
                  data-id="report-session-issue-submit"
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={submitting || !message.trim()}
                  style={{
                    flex: 2,
                    padding: '6px 10px',
                    borderRadius: 4,
                    border: 'none',
                    background:
                      submitting || !message.trim()
                        ? 'var(--bg-secondary)'
                        : 'var(--accent)',
                    color: '#fff',
                    cursor:
                      submitting || !message.trim() ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                    opacity: submitting ? 0.6 : 1,
                  }}
                >
                  {submitting ? 'Bundling…' : 'Send report'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
