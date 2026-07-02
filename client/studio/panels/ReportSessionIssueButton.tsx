/**
 * Header button in CodingAgentChat that lets a user file an issue
 * report for the current coding session. On submit, the sidecar
 * collects the session's on-disk artifacts (messages, telemetry,
 * finish events, Electron log tail, env fingerprint), redacts
 * secrets, uploads the gzipped tar to R2's temp bucket (7-day TTL),
 * and emails a Claude-Code-ready markdown report to the studio
 * maintainer.
 *
 * No DB row is written — the email is the only sink.
 *
 * Modeled on `FeedbackToolbarButton` (same popover chrome) but lives
 * inside the coding-agent panel so the user is reporting "this
 * session" rather than "this app".
 */
import { Bug, Check } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

type IssueType = 'bug' | 'feature' | 'design';

const BUTTON_SIZE_PX = 28;
const POPUP_WIDTH = 340;

export function ReportSessionIssueButton({
  compositeId,
}: {
  compositeId: string;
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
      const res = await fetch('/api/submitSessionIssueReport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          input: {
            compositeId,
            description: message.trim(),
            type,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `submit failed: ${res.status}${
            body ? ` — ${body.slice(0, 200)}` : ''
          }`,
        );
      }
      const payload = (await res.json()) as {
        result?: { reportId?: string };
        reportId?: string;
      };
      const reportId = payload.result?.reportId ?? payload.reportId ?? '?';
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
                Bundles this session&apos;s logs (messages, telemetry, finish
                events, app log tail) and emails the studio maintainer a link to
                the bundle. Bundle auto-deletes after 7 days.
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
