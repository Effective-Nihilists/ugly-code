// "How the advanced modes work" — a design-forward explainer opened from the
// settings ("Learn how these modes work →"). ugly-code hides three optional
// modes behind a toggle so the default interface stays simple; this modal
// teaches the tradeoff each one makes, with a self-contained interactive
// diagram per mode (React + inline SVG/HTML + useState, no external libs, no
// network). It is theme-aware via the studio CSS custom-property tokens.
import React, { useState } from 'react';
import { Modal } from '../system';

// ── Shared token-flavored style atoms ────────────────────────────────────────

const MONO = 'var(--font-mono, monospace)';

/** Uppercase micro-label, the studio's signature eyebrow treatment. */
const eyebrowCss: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.12em',
  color: 'var(--accent)',
};

const bodyCss: React.CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.6,
  color: 'var(--text-secondary)',
};

/** A soft accent wash used for "active / advanced" surfaces. */
function accentTint(pct: number): string {
  return `color-mix(in srgb, var(--accent) ${pct}%, transparent)`;
}

/**
 * A segmented toggle — the one interaction primitive every diagram shares.
 * Kept intentionally plain so the diagram content, not the chrome, is the
 * memorable part.
 */
function Seg<T extends string>({
  options,
  value,
  onChange,
  idBase,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  idBase: string;
}): React.ReactElement {
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border)',
        borderRadius: 7,
        overflow: 'hidden',
        background: 'var(--bg-secondary)',
      }}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            data-id={`${idBase}-${o.value}`}
            type="button"
            onClick={() => {
              onChange(o.value);
            }}
            style={{
              fontFamily: MONO,
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: '0.04em',
              padding: '6px 13px',
              border: 'none',
              borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
              background: active ? accentTint(18) : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer',
              transition: 'background 140ms ease, color 140ms ease',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Small square stepper (− N +) reused by the multi-model fan-out. */
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  idBase,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  idBase: string;
}): React.ReactElement {
  const btn = (
    delta: number,
    disabled: boolean,
    sym: string,
  ): React.ReactElement => (
    <button
      type="button"
      data-id={`${idBase}-${delta > 0 ? 'inc' : 'dec'}`}
      disabled={disabled}
      onClick={() => {
        onChange(value + delta);
      }}
      aria-label={delta > 0 ? `Increase ${label}` : `Decrease ${label}`}
      style={{
        width: 26,
        height: 26,
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--bg-secondary)',
        color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
        fontFamily: MONO,
        fontSize: 15,
        lineHeight: 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {sym}
    </button>
  );
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: '0.08em',
          color: 'var(--text-muted)',
        }}
      >
        {label}
      </span>
      {btn(-1, value <= min, '−')}
      <span
        style={{
          fontFamily: MONO,
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--accent)',
          minWidth: 14,
          textAlign: 'center',
        }}
      >
        {value}
      </span>
      {btn(1, value >= max, '+')}
    </div>
  );
}

/** The framed stage that holds a diagram + its caption. */
function DiagramFrame({
  controls,
  caption,
  children,
}: {
  controls: React.ReactNode;
  caption: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--bg-panel)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          alignItems: 'center',
          padding: '11px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
        }}
      >
        {controls}
      </div>
      <div style={{ padding: 14, overflowX: 'auto' }}>{children}</div>
      <div
        style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--border)',
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--text-secondary)',
          minHeight: 20,
        }}
      >
        {caption}
      </div>
    </div>
  );
}

// ── Diagram 1: Git worktree isolation ────────────────────────────────────────

type BranchMode = 'direct' | 'worktree';

const WT_STAGES = ['idle', 'edited', 'applied'] as const;
type WtStage = (typeof WT_STAGES)[number];

const WT_CAPTIONS: Record<BranchMode, Record<WtStage, string>> = {
  direct: {
    idle: 'Your branch, clean. The agent will write straight to it.',
    edited:
      'Edits land immediately on your current branch — review in the Git panel.',
    applied: 'Nothing to apply: the work is already on your branch.',
  },
  worktree: {
    idle: 'A separate branch under .ugly-studio/worktrees/ shadows your branch.',
    edited:
      'Edits are quarantined on the worktree branch — your working tree is untouched.',
    applied:
      'Apply → tsc · lint · test gates pass → squash-merged into your branch.',
  },
};

function WorktreeDiagram(): React.ReactElement {
  const [mode, setMode] = useState<BranchMode>('worktree');
  const [stageIdx, setStageIdx] = useState(0);
  const stage: WtStage = WT_STAGES[stageIdx] ?? 'idle';

  const advance = (): void => {
    setStageIdx((i) => (i + 1) % WT_STAGES.length);
  };
  const reset = (): void => {
    setStageIdx(0);
  };

  const yMain = 132;
  const yWork = 56;
  const edited = stage === 'edited' || stage === 'applied';
  const applied = stage === 'applied';

  const dot = (
    cx: number,
    cy: number,
    fill: string,
    stroke: string,
    key: string,
  ): React.ReactElement => (
    <circle
      key={key}
      cx={cx}
      cy={cy}
      r={8}
      fill={fill}
      stroke={stroke}
      strokeWidth={2}
      style={{ transition: 'opacity 200ms ease' }}
    />
  );

  return (
    <DiagramFrame
      controls={
        <>
          <Seg<BranchMode>
            idBase="wt-mode"
            value={mode}
            onChange={(m) => {
              setMode(m);
              reset();
            }}
            options={[
              { value: 'direct', label: 'Current branch' },
              { value: 'worktree', label: 'Worktree' },
            ]}
          />
          <div style={{ flex: 1 }} />
          <button
            type="button"
            data-id="wt-step"
            onClick={advance}
            style={{
              fontFamily: MONO,
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: '0.06em',
              padding: '6px 14px',
              borderRadius: 7,
              border: '1px solid var(--accent)',
              background: accentTint(14),
              color: 'var(--accent)',
              cursor: 'pointer',
            }}
          >
            {stage === 'applied' ? 'Reset ↺' : 'Step →'}
          </button>
        </>
      }
      caption={WT_CAPTIONS[mode][stage]}
    >
      <svg
        viewBox="0 0 520 176"
        width="100%"
        style={{ minWidth: 420, display: 'block' }}
        role="img"
        aria-label={`Git ${mode} flow, stage ${stage}`}
      >
        {/* your branch spine */}
        <line
          x1={40}
          y1={yMain}
          x2={480}
          y2={yMain}
          stroke="var(--border)"
          strokeWidth={2}
        />
        <text
          x={40}
          y={yMain + 28}
          fill="var(--text-muted)"
          fontFamily="var(--font-mono, monospace)"
          fontSize={11}
        >
          your branch
        </text>
        {/* existing history */}
        {dot(70, yMain, 'var(--bg-secondary)', 'var(--text-muted)', 'h1')}
        {dot(150, yMain, 'var(--bg-secondary)', 'var(--text-muted)', 'h2')}

        {mode === 'direct' ? (
          <>
            {/* direct edit lands on the spine */}
            {edited && (
              <>
                <line
                  x1={150}
                  y1={yMain}
                  x2={250}
                  y2={yMain}
                  stroke="var(--accent)"
                  strokeWidth={2}
                />
                {dot(250, yMain, 'var(--accent)', 'var(--accent)', 'd1')}
                <text
                  x={250}
                  y={yMain - 16}
                  textAnchor="middle"
                  fill="var(--accent)"
                  fontFamily="var(--font-mono, monospace)"
                  fontSize={11}
                >
                  agent edit
                </text>
              </>
            )}
          </>
        ) : (
          <>
            {/* worktree branch spine */}
            <line
              x1={150}
              y1={yMain}
              x2={210}
              y2={yWork}
              stroke={edited ? 'var(--accent)' : 'var(--border)'}
              strokeWidth={2}
              style={{ transition: 'stroke 200ms ease' }}
            />
            <line
              x1={210}
              y1={yWork}
              x2={applied ? 330 : 420}
              y2={yWork}
              stroke={edited ? 'var(--accent)' : 'var(--border)'}
              strokeWidth={2}
              strokeDasharray={edited ? undefined : '5 5'}
              style={{ transition: 'stroke 200ms ease' }}
            />
            <text
              x={210}
              y={yWork - 16}
              fill={edited ? 'var(--accent)' : 'var(--text-muted)'}
              fontFamily="var(--font-mono, monospace)"
              fontSize={11}
            >
              .ugly-studio/worktrees/…
            </text>
            {/* quarantined edits */}
            {edited && dot(260, yWork, 'var(--accent)', 'var(--accent)', 'w1')}
            {edited && dot(330, yWork, 'var(--accent)', 'var(--accent)', 'w2')}

            {/* apply: squash-merge back down */}
            {applied && (
              <>
                <line
                  x1={330}
                  y1={yWork}
                  x2={410}
                  y2={yMain}
                  stroke="var(--success)"
                  strokeWidth={2}
                />
                {dot(410, yMain, 'var(--success)', 'var(--success)', 'm1')}
                <text
                  x={410}
                  y={yMain - 16}
                  textAnchor="middle"
                  fill="var(--success)"
                  fontFamily="var(--font-mono, monospace)"
                  fontSize={11}
                >
                  squash-merge
                </text>
                <text
                  x={370}
                  y={yWork + 4}
                  textAnchor="middle"
                  fill="var(--text-muted)"
                  fontFamily="var(--font-mono, monospace)"
                  fontSize={10}
                >
                  tsc · lint · test
                </text>
              </>
            )}
          </>
        )}
      </svg>
    </DiagramFrame>
  );
}

// ── Diagram 2: Plan engine / patterns ────────────────────────────────────────

interface PatternStep {
  key: string;
  label: string;
  detail: string;
}
interface PatternDef {
  value: string;
  name: string;
  gated: boolean;
  steps: PatternStep[];
}

const PATTERNS: PatternDef[] = [
  {
    value: 'flat',
    name: 'Flat loop (default)',
    gated: false,
    steps: [
      {
        key: 'iterate',
        label: 'ITERATE',
        detail:
          'You send a prompt, the agent works and finishes. One continuous loop — no plan, no checkpoints. Fast for small, well-scoped changes.',
      },
    ],
  },
  {
    value: 'spec-build-verify',
    name: 'spec → build → verify',
    gated: true,
    steps: [
      {
        key: 'spec',
        label: 'SPEC',
        detail:
          'The agent writes a short spec: the goal, the surface it will touch, and how it will know it worked. You read it before any code is written.',
      },
      {
        key: 'build',
        label: 'BUILD',
        detail:
          'Implementation strictly against the approved spec. Scope creep gets caught because the spec is the contract.',
      },
      {
        key: 'verify',
        label: 'VERIFY',
        detail:
          'Typecheck, lint and tests run against the spec’s success criteria. Failures loop back into BUILD rather than shipping.',
      },
    ],
  },
  {
    value: 'investigate-fix',
    name: 'investigate → fix',
    gated: true,
    steps: [
      {
        key: 'repro',
        label: 'REPRO',
        detail:
          'Reproduce the bug first — a failing test or a concrete trigger — so the fix has something to prove itself against.',
      },
      {
        key: 'diagnose',
        label: 'DIAGNOSE',
        detail:
          'Trace the root cause and state it plainly before touching code. You confirm the diagnosis at the gate.',
      },
      {
        key: 'fix',
        label: 'FIX',
        detail:
          'The smallest change that addresses the confirmed cause — not the symptom.',
      },
      {
        key: 'verify',
        label: 'VERIFY',
        detail:
          'The repro now passes and nothing else regressed. tsc · lint · test all green.',
      },
    ],
  },
];

function PatternDiagram(): React.ReactElement {
  const [patternValue, setPatternValue] = useState('spec-build-verify');
  const [selected, setSelected] = useState(0);
  const pattern = PATTERNS.find((p) => p.value === patternValue) ?? PATTERNS[0];
  const activeStep = pattern.steps[selected] ?? pattern.steps[0];

  return (
    <DiagramFrame
      controls={
        <>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 11,
              letterSpacing: '0.08em',
              color: 'var(--text-muted)',
            }}
          >
            pattern
          </span>
          <select
            data-id="pattern-select"
            value={patternValue}
            onChange={(e) => {
              setPatternValue(e.target.value);
              setSelected(0);
            }}
            style={{
              fontFamily: MONO,
              fontSize: 12,
              padding: '6px 10px',
              borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
            }}
          >
            {PATTERNS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.name}
              </option>
            ))}
          </select>
        </>
      }
      caption={
        <span>
          <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
            {activeStep.label}
          </span>{' '}
          — {activeStep.detail}
        </span>
      }
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'stretch',
          gap: 6,
          minWidth: 'min-content',
        }}
      >
        {pattern.steps.map((step, i) => {
          const active = i === selected;
          return (
            <React.Fragment key={step.key}>
              <button
                type="button"
                data-id={`pattern-step-${step.key}`}
                onClick={() => {
                  setSelected(i);
                }}
                style={{
                  flex: '1 1 96px',
                  minWidth: 96,
                  padding: '18px 12px',
                  borderRadius: 8,
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  background: active ? accentTint(16) : 'var(--bg-secondary)',
                  color: active ? 'var(--accent)' : 'var(--text-secondary)',
                  fontFamily: MONO,
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  cursor: 'pointer',
                  transition: 'all 140ms ease',
                }}
              >
                {step.label}
                {pattern.value === 'flat' && (
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 400,
                      letterSpacing: '0.04em',
                      marginTop: 4,
                      color: 'var(--text-muted)',
                    }}
                  >
                    {'↺'} repeat until done
                  </div>
                )}
              </button>
              {/* review gate between steps */}
              {pattern.gated && i < pattern.steps.length - 1 && (
                <div
                  aria-hidden
                  title="review gate — you approve before the next step"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 3,
                    minWidth: 30,
                    color: 'var(--text-muted)',
                  }}
                >
                  <span style={{ fontFamily: MONO, fontSize: 15 }}>{'→'}</span>
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 8.5,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: 'var(--warning)',
                    }}
                  >
                    gate
                  </span>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </DiagramFrame>
  );
}

// ── Diagram 3: Multi-model group & max ───────────────────────────────────────

type FanMode = 'max' | 'group';

function MultiModelDiagram(): React.ReactElement {
  const [mode, setMode] = useState<FanMode>('max');
  const [n, setN] = useState(3);
  const [winner, setWinner] = useState(0);

  const W = 520;
  const H = 210;
  const promptX = 62;
  const promptY = H / 2;
  const nodeX = 268;
  const judgeX = 452;
  const clampWinner = winner < n ? winner : 0;

  const nodeY = (i: number): number => {
    const gap = 46;
    const total = (n - 1) * gap;
    return H / 2 - total / 2 + i * gap;
  };

  return (
    <DiagramFrame
      controls={
        <>
          <Seg<FanMode>
            idBase="fan-mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'max', label: 'Max · compete' },
              { value: 'group', label: 'Group · collaborate' },
            ]}
          />
          <div style={{ flex: 1 }} />
          <Stepper
            idBase="fan-n"
            label="models"
            value={n}
            min={2}
            max={4}
            onChange={(next) => {
              setN(next);
              if (winner >= next) setWinner(0);
            }}
          />
        </>
      }
      caption={
        mode === 'max' ? (
          <span>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>max</span>{' '}
            — {n} models run the same turn; a judge keeps the best. Click a node
            to pick a different winner. Best-of-N, higher cost.
          </span>
        ) : (
          <span>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
              group
            </span>{' '}
            — {n} models share a blackboard and build on each other for one
            combined answer. Diverse perspectives, higher cost.
          </span>
        )
      }
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ minWidth: 440, display: 'block' }}
        role="img"
        aria-label={`Multi-model ${mode} with ${n} models`}
      >
        {/* prompt → nodes fan-out */}
        {Array.from({ length: n }, (_, i) => (
          <line
            key={`in-${i}`}
            x1={promptX + 34}
            y1={promptY}
            x2={nodeX - 26}
            y2={nodeY(i)}
            stroke="var(--border)"
            strokeWidth={1.5}
          />
        ))}

        {/* group: mesh between the model nodes (shared blackboard) */}
        {mode === 'group' &&
          Array.from({ length: n }, (_, i) =>
            Array.from({ length: n }, (_, j) =>
              j > i ? (
                <line
                  key={`mesh-${i}-${j}`}
                  x1={nodeX}
                  y1={nodeY(i)}
                  x2={nodeX}
                  y2={nodeY(j)}
                  stroke={accentTint(55)}
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                />
              ) : null,
            ),
          )}

        {/* max: nodes → judge, then judge → output */}
        {mode === 'max' && (
          <>
            {Array.from({ length: n }, (_, i) => (
              <line
                key={`out-${i}`}
                x1={nodeX + 26}
                y1={nodeY(i)}
                x2={judgeX - 18}
                y2={promptY}
                stroke={i === clampWinner ? 'var(--success)' : 'var(--border)'}
                strokeWidth={i === clampWinner ? 2.5 : 1.5}
              />
            ))}
          </>
        )}

        {/* prompt node */}
        <g>
          <rect
            x={promptX - 34}
            y={promptY - 20}
            width={68}
            height={40}
            rx={7}
            fill="var(--bg-secondary)"
            stroke="var(--text-muted)"
            strokeWidth={1.5}
          />
          <text
            x={promptX}
            y={promptY + 4}
            textAnchor="middle"
            fill="var(--text-secondary)"
            fontFamily="var(--font-mono, monospace)"
            fontSize={11}
          >
            prompt
          </text>
        </g>

        {/* model nodes */}
        {Array.from({ length: n }, (_, i) => {
          const isWinner = mode === 'max' && i === clampWinner;
          return (
            <g
              key={`node-${i}`}
              data-id={`fan-node-${i}`}
              onClick={() => {
                if (mode === 'max') setWinner(i);
              }}
              style={{ cursor: mode === 'max' ? 'pointer' : 'default' }}
            >
              <circle
                cx={nodeX}
                cy={nodeY(i)}
                r={22}
                fill={
                  isWinner
                    ? 'color-mix(in srgb, var(--success) 20%, var(--bg-secondary))'
                    : mode === 'group'
                      ? accentTint(12)
                      : 'var(--bg-secondary)'
                }
                stroke={
                  isWinner
                    ? 'var(--success)'
                    : mode === 'group'
                      ? 'var(--accent)'
                      : 'var(--border)'
                }
                strokeWidth={2}
                style={{ transition: 'all 160ms ease' }}
              />
              <text
                x={nodeX}
                y={nodeY(i) + 4}
                textAnchor="middle"
                fill="var(--text-secondary)"
                fontFamily="var(--font-mono, monospace)"
                fontSize={11}
                style={{ pointerEvents: 'none' }}
              >
                m{i + 1}
              </text>
              {isWinner && (
                <text
                  x={nodeX + 22}
                  y={nodeY(i) - 16}
                  textAnchor="middle"
                  fontSize={15}
                  style={{ pointerEvents: 'none' }}
                >
                  {'\u{1F3C6}'}
                </text>
              )}
            </g>
          );
        })}

        {/* max: judge / output node */}
        {mode === 'max' ? (
          <g>
            <rect
              x={judgeX - 18}
              y={promptY - 20}
              width={62}
              height={40}
              rx={7}
              fill="color-mix(in srgb, var(--success) 14%, var(--bg-secondary))"
              stroke="var(--success)"
              strokeWidth={1.5}
            />
            <text
              x={judgeX + 13}
              y={promptY + 4}
              textAnchor="middle"
              fill="var(--success)"
              fontFamily="var(--font-mono, monospace)"
              fontSize={11}
            >
              judge
            </text>
          </g>
        ) : (
          <text
            x={nodeX + 70}
            y={promptY + 4}
            fill="var(--text-muted)"
            fontFamily="var(--font-mono, monospace)"
            fontSize={11}
          >
            ⇄ shared
          </text>
        )}
      </svg>
    </DiagramFrame>
  );
}

// ── Mode section wrapper ─────────────────────────────────────────────────────

/** The "Default: … / Advanced: …" contrast rows that lead each mode. */
function Tradeoff({
  def,
  adv,
}: {
  def: string;
  adv: string;
}): React.ReactElement {
  const row = (
    tag: string,
    text: string,
    accent: boolean,
  ): React.ReactElement => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span
        style={{
          flexShrink: 0,
          width: 74,
          fontFamily: MONO,
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: accent ? 'var(--accent)' : 'var(--text-muted)',
        }}
      >
        {tag}
      </span>
      <span
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--text-secondary)',
        }}
      >
        {text}
      </span>
    </div>
  );
  return (
    <div
      style={{
        display: 'grid',
        gap: 8,
        padding: '12px 14px',
        borderLeft: '2px solid var(--accent)',
        background: accentTint(6),
        borderRadius: '0 8px 8px 0',
      }}
    >
      {row('Default', def, false)}
      {row('Advanced', adv, true)}
    </div>
  );
}

function ModeSection({
  slug,
  title,
  def,
  adv,
  whenToUse,
  diagram,
}: {
  slug: string;
  title: string;
  def: string;
  adv: string;
  whenToUse: string;
  diagram: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      style={{
        padding: '26px 24px',
        borderBottom: '1px solid var(--border)',
        display: 'grid',
        gap: 16,
      }}
    >
      <div>
        {/* eyebrow is the real settings key — flip this in Settings */}
        <div style={eyebrowCss}>{slug}</div>
        <h3
          style={{
            margin: '6px 0 0',
            fontFamily: 'var(--font-heading)',
            fontSize: 21,
            fontWeight: 800,
            letterSpacing: '-0.02em',
            color: 'var(--text-primary)',
          }}
        >
          {title}
        </h3>
      </div>
      <Tradeoff def={def} adv={adv} />
      <div style={{ ...bodyCss, display: 'flex', gap: 8 }}>
        <span
          style={{
            flexShrink: 0,
            fontFamily: MONO,
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            paddingTop: 1,
          }}
        >
          Use when
        </span>
        <span>{whenToUse}</span>
      </div>
      {diagram}
    </section>
  );
}

// ── The modal ────────────────────────────────────────────────────────────────

export function ModesExplainerModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.ReactElement | null {
  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      ariaLabel="How the advanced modes work"
      cardStyle={{ maxHeight: '90vh' }}
    >
      <Modal.Header>How the advanced modes work</Modal.Header>
      <Modal.Body>
        {/* Intro */}
        <div
          style={{
            padding: '22px 24px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-panel)',
          }}
        >
          <p style={{ margin: 0, ...bodyCss, fontSize: 14.5 }}>
            ugly-code keeps the interface simple by default. These three
            optional modes trade simplicity for control — turn them on in{' '}
            <span
              style={{
                fontFamily: MONO,
                fontSize: 12.5,
                padding: '1px 6px',
                borderRadius: 5,
                border: '1px solid var(--border)',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
              }}
            >
              Settings
            </span>{' '}
            when you need them.
          </p>
        </div>

        <ModeSection
          slug="branch.mode"
          title="Git worktree isolation"
          def="The agent edits files directly on your current branch — changes appear in your project immediately, and you review them in the Git panel."
          adv="Each session's edits are quarantined on a separate branch inside .ugly-studio/worktrees/, untouched until you click Apply — which squash-merges into your branch only after the tsc · lint · test gates pass."
          whenToUse="the change is risky, you're running parallel sessions, or you want to review before anything lands."
          diagram={<WorktreeDiagram />}
        />

        <ModeSection
          slug="plan.pattern"
          title="Plan engine & patterns"
          def="A flat iteration loop — you send a prompt, the agent works and finishes."
          adv="Structured multi-step engines with review gates. spec → build → verify writes a spec, builds to it, then verifies; investigate → fix reproduces, diagnoses, fixes, verifies."
          whenToUse="the task is large or ambiguous and you want a plan plus checkpoints between steps."
          diagram={<PatternDiagram />}
        />

        <ModeSection
          slug="model.mode"
          title="Multi-model: group & max"
          def="One model per turn — a single pinned model, or an auto-router that picks one for you."
          adv="max runs N models on the same turn competitively and a judge keeps the best result. group has N models collaborate over a shared blackboard for one combined answer."
          whenToUse="the problem is hard and worth the extra cost for best-of-N or diverse perspectives."
          diagram={<MultiModelDiagram />}
        />
      </Modal.Body>
      <Modal.Footer>
        <button
          type="button"
          data-id="modes-explainer-done"
          onClick={onClose}
          style={{
            fontFamily: 'var(--font-label)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-primary)',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            padding: '8px 18px',
            cursor: 'pointer',
          }}
        >
          Done
        </button>
      </Modal.Footer>
    </Modal>
  );
}
