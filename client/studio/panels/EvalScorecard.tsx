import React from 'react';
import type { EvalGradeResult } from '../shared/api';

/**
 * Renders the grader's verdict on an eval run.
 *
 * Composes three sections:
 *   1. Header — task name, score (e.g. "4/5"), graded-at timestamp.
 *   2. Summary — one-paragraph plain-language explanation.
 *   3. Deterministic checks — per-row pass/fail with optional detail.
 *   4. tsc result.
 *   5. LLM judge gates (when present) — per-gate points + verdict.
 *   6. Run totals — wall-clock, turns, cost, tokens.
 *
 * Persisted on the session's `eval.json` so the chat re-renders the
 * card on every mount after the user has graded a run (survives app
 * restart).
 */
export function EvalScorecard({
  result,
  onClose,
}: {
  result: EvalGradeResult;
  /**
   * When provided, renders a close (✕) button next to the score in
   * the header. Used by the modal wrapper so the dismiss control
   * sits on the same row as the score — the scorecard already has
   * its own pass/fail border, so a second close affordance on the
   * outer modal would be redundant chrome.
   */
  onClose?: () => void;
}): React.ReactElement {
  const scoreFraction =
    typeof result.score === 'number' && typeof result.scoreMax === 'number'
      ? `${result.score} / ${result.scoreMax}`
      : null;
  const judgeAwarded = (result.judgeResults ?? []).reduce(
    (sum, j) => sum + j.pointsAwarded,
    0,
  );
  const judgePossible = (result.judgeResults ?? []).reduce(
    (sum, j) => sum + j.points,
    0,
  );
  const tscOk = result.tscExit === 0;
  return (
    <div
      data-id="eval-scorecard"
      style={{
        border: `2px solid ${
          result.skipped
            ? 'var(--border)'
            : (result.score ?? 0) >= (result.scoreMax ?? 0)
            ? '#3a8c4a'
            : 'var(--accent)'
        }`,
        background: 'var(--bg-secondary)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        margin: '12px 0',
      }}
    >
      <Header
        taskName={result.taskName}
        gradedAt={result.gradedAt}
        scoreFraction={scoreFraction}
        skipped={result.skipped}
        {...(onClose ? { onClose } : {})}
      />

      {result.summary && (
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-primary)',
            lineHeight: 1.5,
            background: 'var(--bg-primary)',
            padding: '10px 12px',
            borderLeft: '3px solid var(--accent)',
          }}
        >
          {result.summary}
        </div>
      )}

      {result.checks && result.checks.length > 0 && (
        <Section title="Deterministic checks">
          {result.checks.map((c, i) => (
            <CheckRow
              key={i}
              passed={c.passed}
              name={c.name}
              detail={c.detail}
            />
          ))}
        </Section>
      )}

      {typeof result.tscExit === 'number' && (
        <Section title="TypeScript">
          <CheckRow
            passed={tscOk}
            name={`tsc --noEmit ${
              tscOk
                ? 'clean'
                : `failed (${result.tscErrors ?? '?'} error${
                    result.tscErrors === 1 ? '' : 's'
                  })`
            }`}
            {...(result.tscErrorSample
              ? { detail: result.tscErrorSample }
              : {})}
          />
        </Section>
      )}

      {result.judgeResults && result.judgeResults.length > 0 && (
        <Section title={`LLM judge (${judgeAwarded}/${judgePossible})`}>
          {result.judgeResults.map((j, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '8px 10px',
                background: 'var(--bg-primary)',
                borderLeft: `3px solid ${
                  j.pointsAwarded === j.points
                    ? '#3a8c4a'
                    : j.pointsAwarded === 0
                    ? '#FF5500'
                    : 'var(--text-secondary)'
                }`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: 12,
                    color: 'var(--text-primary)',
                  }}
                >
                  {j.gateName}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-label)',
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                  }}
                >
                  {j.pointsAwarded} / {j.points} pts · {j.rubricKey}
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  lineHeight: 1.5,
                }}
              >
                {j.verdict}
              </div>
            </div>
          ))}
        </Section>
      )}

      <RunTotals totals={result.runTotals} />
    </div>
  );
}

function Header({
  taskName,
  gradedAt,
  scoreFraction,
  skipped,
  onClose,
}: {
  taskName: string;
  gradedAt: string;
  scoreFraction: string | null;
  skipped?: string;
  onClose?: () => void;
}): React.ReactElement {
  let when: string;
  try {
    when = new Date(gradedAt).toLocaleString();
  } catch {
    when = gradedAt;
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
          Eval scorecard
        </div>
        <div
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: 18,
            fontWeight: 800,
            color: 'var(--text-primary)',
            lineHeight: 1.2,
          }}
        >
          {taskName}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-secondary)',
          }}
        >
          Graded {when}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {scoreFraction && !skipped && (
          <div
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 28,
              fontWeight: 800,
              color: 'var(--text-primary)',
              lineHeight: 1,
              whiteSpace: 'nowrap',
            }}
          >
            {scoreFraction}
          </div>
        )}
        {onClose && (
          <button
            type="button"
            data-id="eval-scorecard-close"
            onClick={onClose}
            aria-label="Close scoreboard"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              width: 28,
              height: 28,
              padding: 0,
              fontSize: 16,
              lineHeight: 1,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        )}
      </div>
      {skipped && (
        <div
          style={{
            fontFamily: 'var(--font-label)',
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            fontWeight: 700,
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
            padding: '4px 8px',
          }}
        >
          Skipped
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

function CheckRow({
  passed,
  name,
  detail,
}: {
  passed: boolean;
  name: string;
  detail?: string;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '4px 0',
      }}
    >
      <span
        style={{
          color: passed ? '#6abf6a' : '#FF5500',
          fontFamily: 'var(--font-label)',
          fontSize: 12,
          fontWeight: 700,
          minWidth: 28,
        }}
      >
        {passed ? 'PASS' : 'FAIL'}
      </span>
      <div style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)' }}>
        <div style={{ lineHeight: 1.4 }}>{name}</div>
        {detail && (
          <pre
            style={{
              margin: '4px 0 0 0',
              fontSize: 11,
              color: 'var(--text-secondary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: 'var(--bg-primary)',
              padding: '6px 8px',
              maxHeight: 160,
              overflow: 'auto',
            }}
          >
            {detail}
          </pre>
        )}
      </div>
    </div>
  );
}

function RunTotals({
  totals,
}: {
  totals: EvalGradeResult['runTotals'];
}): React.ReactElement {
  const secs = Math.floor(totals.durationMs / 1000);
  const minutes = Math.floor(secs / 60);
  const secsRem = secs % 60;
  const wall = minutes > 0 ? `${minutes}m ${secsRem}s` : `${secs}s`;
  const cells: { label: string; value: string }[] = [
    { label: 'Wall clock', value: wall },
    { label: 'Turns', value: String(totals.turns) },
    { label: 'Cost', value: `$${totals.cost.total.toFixed(4)}` },
    {
      label: 'Tokens in',
      value: formatTokens(
        totals.tokens.input +
          totals.tokens.cacheRead +
          totals.tokens.cacheCreate,
      ),
    },
    { label: 'Tokens out', value: formatTokens(totals.tokens.output) },
  ];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 8,
        background: 'var(--bg-primary)',
        padding: '10px 12px',
      }}
    >
      {cells.map((c) => (
        <div
          key={c.label}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-label)',
              fontSize: 9,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              fontWeight: 700,
              color: 'var(--text-secondary)',
            }}
          >
            {c.label}
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--text-primary)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
