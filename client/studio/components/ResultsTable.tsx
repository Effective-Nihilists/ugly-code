/**
 * Tabular result renderer for database queries.
 * Shared across Database, Errors, Perf, and Feedback panels.
 */

interface ResultsTableProps {
  columns: string[];
  rows: Record<string, unknown>[];
}

function cellValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function ResultsTable({ columns, rows }: ResultsTableProps) {
  if (columns.length === 0) return null;

  return (
    <div
      data-id="results-table"
      style={{
        overflowX: 'auto',
        border: '1px solid var(--border-primary)',
        borderRadius: 4,
      }}
    >
      <table
        style={{
          borderCollapse: 'collapse',
          width: '100%',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 12,
        }}
      >
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                style={{
                  padding: '6px 10px',
                  borderBottom: '2px solid var(--border-primary)',
                  background: 'var(--bg-secondary)',
                  textAlign: 'left',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  color: 'var(--text-primary)',
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => (
                <td
                  key={col}
                  style={{
                    padding: '4px 10px',
                    borderBottom: '1px solid var(--border-primary)',
                    whiteSpace: 'nowrap',
                    maxWidth: 400,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    color:
                      row[col] === null
                        ? 'var(--text-muted, #999)'
                        : 'var(--text-primary)',
                    fontStyle: row[col] === null ? 'italic' : 'normal',
                  }}
                  title={cellValue(row[col])}
                >
                  {cellValue(row[col])}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  padding: '16px 10px',
                  textAlign: 'center',
                  color: 'var(--text-primary)',
                  opacity: 0.5,
                }}
              >
                No rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
