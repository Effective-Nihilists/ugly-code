import React from 'react';
import type { LspResult } from './editorLsp';

/** Group reference hits by file, preserving first-seen file order. Pure. */
export function groupReferences(results: LspResult[]): { path: string; hits: LspResult[] }[] {
  const order: string[] = [];
  const by = new Map<string, LspResult[]>();
  for (const r of results) {
    if (!by.has(r.path)) {
      by.set(r.path, []);
      order.push(r.path);
    }
    by.get(r.path)!.push(r);
  }
  return order.map((path) => ({ path, hits: by.get(path)! }));
}

/** Bottom results panel for Find References — rows navigate on click. */
export function ReferencesPanel({
  results,
  onPick,
  onClose,
}: {
  results: LspResult[];
  onPick: (r: LspResult) => void;
  onClose: () => void;
}): React.ReactElement | null {
  if (results.length === 0) return null;
  const groups = groupReferences(results);
  return (
    <div data-id="references-panel" style={S.root}>
      <div style={S.header}>
        <span>
          {results.length} reference{results.length === 1 ? '' : 's'}
        </span>
        <button data-id="references-close" onClick={onClose} style={S.close}>
          Close
        </button>
      </div>
      <div style={S.list}>
        {groups.map((g) => (
          <div key={g.path}>
            <div style={S.file}>{g.path}</div>
            {g.hits.map((h, i) => (
              <div
                key={i}
                data-id="reference-row"
                style={S.row}
                onClick={() => onPick(h)}
              >
                <span style={S.loc}>{h.line}</span>
                <span style={S.preview}>{h.preview ?? ''}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  root: { flexShrink: 0, maxHeight: 220, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)', background: 'var(--bg-panel)', fontFamily: 'var(--font-mono)', fontSize: 12 },
  header: { flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' },
  close: { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 12 },
  list: { overflow: 'auto' },
  file: { padding: '4px 12px', color: 'var(--text-secondary)', fontWeight: 600, background: 'var(--bg-secondary)' },
  row: { display: 'flex', gap: 10, padding: '3px 12px 3px 24px', cursor: 'pointer', color: 'var(--text-primary)' },
  loc: { color: 'var(--text-muted)', minWidth: 32 },
  preview: { color: 'var(--text-secondary)', whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis' },
};
