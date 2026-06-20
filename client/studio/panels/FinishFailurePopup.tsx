/**
 * Failure popup shown when the Done pipeline can't recover on its
 * own — auto-fix exhausted, conflicts unsolvable, gates broken.
 *
 * Stage-specific copy explains *what* failed and *how the user can
 * fix it manually*, then offers Close, Retry, and (for tsc/lint/tests)
 * "Retry without this gate" actions.
 */

import { Modal } from '../system';

export type FailureStage =
  | 'precheck_dirty_main'
  | 'merge_parent'
  | 'tsc'
  | 'lint'
  | 'tests'
  | 'merge_squash'
  | 'cleanup'
  | 'conflict';

export interface FinishFailureInfo {
  stage: FailureStage;
  /**
   * For 'conflict' the chat UI doesn't know whether the conflict was at
   * merge_parent or merge_squash without inspecting the pipeline's
   * conflictStage field — we expose it here so the headline copy can
   * differ ("Couldn't reconcile parent merge" vs. "Squash to parent
   * conflicted").
   */
  conflictStage?: 'merge_parent' | 'merge_squash';
  message?: string;
  conflicts?: string[];
  dirtyFiles?: string[];
  lastStageOutput?: string;
}

interface CopyEntry {
  headline: string;
  howToFix: string;
}

function getCopy(info: FinishFailureInfo): CopyEntry {
  switch (info.stage) {
    case 'precheck_dirty_main':
      return {
        headline: 'Main repo has uncommitted changes',
        howToFix:
          "Done can't squash-merge while the main repo has uncommitted edits. Either commit / stash / discard the listed files, then click Retry — or re-run Done so the precheck dialog can offer to commit them automatically.",
      };
    case 'conflict': {
      const where =
        info.conflictStage === 'merge_squash'
          ? 'parent (squash merge)'
          : 'parent';
      return {
        headline: "AI couldn't reconcile merge conflicts",
        howToFix: `After 3 attempts the conflicts merging ${where} still aren't resolved. Open the worktree, hand-resolve the \`<<<<<<<\` / \`>>>>>>>\` markers, \`git add\` the files, \`git commit\`, then click Retry.`,
      };
    }
    case 'tsc':
      return {
        headline: "TypeScript errors couldn't be auto-fixed",
        howToFix:
          'After 3 fix attempts the typecheck still fails. Read the output, fix the types in the worktree, then click Retry — or click "Retry without typecheck" to finish anyway.',
      };
    case 'lint':
      return {
        headline: "Lint errors couldn't be auto-fixed",
        howToFix:
          'After 3 fix attempts lint still fails. Common causes: rules that need manual judgment, formatter conflicts, or file ignores. Fix the issues, then click Retry — or click "Retry without lint".',
      };
    case 'tests':
      return {
        headline: 'Tests failed',
        howToFix:
          'Tests aren\'t auto-fixed — a failing test usually flags a real intent conflict. Read the failures, decide whether the test or the code is wrong, fix and click Retry — or click "Retry without tests".',
      };
    case 'merge_parent':
      return {
        headline: "Couldn't merge parent into the worktree",
        howToFix:
          'Pull the latest parent inside the worktree, resolve any conflicts, and click Retry. If the parent itself is broken, you may need to fix it in the main repo first.',
      };
    case 'merge_squash':
      return {
        headline: 'Squash merge to parent conflicted',
        howToFix:
          'While merging this session into the parent branch, the main checkout had divergent edits. Pull the latest parent in the main repo, resolve any conflicts, then click Retry.',
      };
    case 'cleanup':
      return {
        headline: 'Merge succeeded but cleanup hit an error',
        howToFix:
          'The session merged safely. Manually run `git worktree remove <worktreePath>` and `git branch -D <sessionBranch>`, then reload the panel.',
      };
  }
}

export function FinishFailurePopup({
  info,
  onClose,
  onRetry,
  onSkipGate,
}: {
  info: FinishFailureInfo;
  onClose: () => void;
  onRetry?: () => void;
  onSkipGate?: (stage: 'tsc' | 'lint' | 'tests') => void;
}) {
  const { headline, howToFix } = getCopy(info);
  const skippable =
    info.stage === 'tsc' || info.stage === 'lint' || info.stage === 'tests';

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      ariaLabel={`Done failed: ${info.stage}`}
      cardStyle={{
        borderRadius: 8,
        maxHeight: '80vh',
        boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
      }}
    >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(239, 68, 68, 0.08)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--error)',
            }}
          >
            Done failed · {info.stage}
          </div>
          <h2
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            {headline}
          </h2>
        </div>

        <div
          style={{
            padding: '14px 18px',
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-primary)',
              lineHeight: 1.5,
            }}
          >
            {howToFix}
          </div>

          {info.dirtyFiles && info.dirtyFiles.length > 0 && (
            <FileList
              title="Dirty files in main repo"
              items={info.dirtyFiles}
            />
          )}
          {info.conflicts && info.conflicts.length > 0 && (
            <FileList title="Conflicting files" items={info.conflicts} />
          )}
          {info.lastStageOutput && info.lastStageOutput.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--text-secondary)',
                  marginBottom: 4,
                }}
              >
                Last stage output
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                  maxHeight: 220,
                  overflow: 'auto',
                }}
              >
                {info.lastStageOutput.slice(-4000)}
              </pre>
            </div>
          )}

          {info.message && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {info.message}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            flexShrink: 0,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '6px 16px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
          {skippable && onSkipGate && (
            <button
              type="button"
              onClick={() => onSkipGate(info.stage as 'tsc' | 'lint' | 'tests')}
              style={{
                background: 'transparent',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '6px 16px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Retry without {info.stage}
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={{
                background: 'var(--accent)',
                color: 'var(--on-accent)',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                padding: '6px 16px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Retry Finish
            </button>
          )}
        </div>
    </Modal>
  );
}

function FileList({ title, items }: { title: string; items: string[] }) {
  const visible = items.slice(0, 12);
  const extra = items.length - visible.length;
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div
        style={{
          padding: 8,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
        }}
      >
        {visible.map((p) => (
          <div key={p}>{p}</div>
        ))}
        {extra > 0 && (
          <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
            + {extra} more
          </div>
        )}
      </div>
    </div>
  );
}
