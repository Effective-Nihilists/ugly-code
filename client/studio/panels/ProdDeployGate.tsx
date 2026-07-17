import React from 'react';

/**
 * Empty state shown by a prod-scoped panel (Database, Errors, …) when the open
 * project was never deployed — there's no production data source yet, so instead
 * of a raw connection error we prompt the user to publish first (with a button to
 * the Publish tab). `what` names the resource (e.g. "database", "error log").
 */
export function ProdDeployGate({
  what,
  onDeploy,
}: {
  what: string;
  onDeploy?: () => void;
}): React.ReactElement {
  return (
    <div
      data-id="prod-publish-gate"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 12,
        padding: 24,
        textAlign: 'center',
      }}
    >
      <span
        style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}
      >
        No production {what} yet
      </span>
      <span
        style={{
          fontSize: 13,
          color: 'var(--text-secondary)',
          maxWidth: 440,
          lineHeight: 1.5,
        }}
      >
        This project hasn’t been published yet, so there’s nothing to show here.
        Publish it first to provision it — then it’ll appear.
      </span>
      {onDeploy && (
        <button
          data-id="publish-first"
          onClick={onDeploy}
          style={{
            background: 'var(--accent)',
            color: 'var(--on-accent, #fff)',
            border: 'none',
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Deploy project →
        </button>
      )}
    </div>
  );
}
