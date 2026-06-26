// Custom file/folder picker popup — a web-based replacement for the native `fs.pickDirectory`
// dialog, which (being an OS dialog) opens on the DESKTOP and is invisible when the IDE is
// driven from a phone over the Ugly Proxy. This navigates with `native.fs.readdir` (a
// proxyable channel), so it works identically on desktop and proxied mobile.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { native } from 'ugly-app/native';
import type { HostDirent } from 'ugly-app/native';
import { Folder, FileText, ArrowUp, Check } from 'lucide-react';
import { Modal } from '../system/modal/Modal';
import { filterEntries, joinPath, parentPath, basename, type PickMode } from './filePickerUtils';

export interface FilePickerProps {
  /** What's selectable. Folders are always navigable regardless. */
  mode: PickMode;
  /** When files are shown, restrict to these extensions (e.g. ['.ts','.json']); empty = all. */
  extensions?: string[];
  /** Initial directory; '~' resolves to home on the host. */
  startPath?: string;
  title?: string;
  /** Resolved with the chosen absolute path, or null if cancelled/dismissed. Called once. */
  onResult: (path: string | null) => void;
}

export function FilePicker({ mode, extensions, startPath, title, onResult }: FilePickerProps) {
  const [path, setPath] = useState(startPath ?? '~');
  const [raw, setRaw] = useState<HostDirent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    try {
      const ents = await native.fs.readdir(dir);
      setRaw(ents);
      setPath(dir);
    } catch (e) {
      setError((e as Error)?.message || 'Could not open this folder');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(startPath ?? '~');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entries = useMemo(
    () => filterEntries(raw, mode, extensions, showHidden),
    [raw, mode, extensions, showHidden],
  );

  const canSelectFolder = mode === 'folder' || mode === 'both';
  const primaryLabel = selectedFile
    ? `Select ${basename(selectedFile)}`
    : canSelectFolder
      ? 'Use this folder'
      : 'Select';
  const primaryDisabled = selectedFile ? false : !canSelectFolder;
  const confirm = (): void => onResult(selectedFile ?? (canSelectFolder ? path : null));

  return (
    <Modal open onClose={() => onResult(null)} size={560} ariaLabel="File picker" cardStyle={{ padding: 0, gap: 0 }}>
      <div style={{ padding: '16px 18px 10px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontFamily: 'var(--font-label)', fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>
          {title ?? (mode === 'file' ? 'Select a file' : 'Select a folder')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button data-id="file-picker-up" onClick={() => void load(parentPath(path))} disabled={loading} aria-label="Up one folder" style={iconBtn}>
            <ArrowUp size={15} />
          </button>
          <div style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
            {path}
          </div>
        </div>
      </div>

      <div style={{ height: 320, overflowY: 'auto', padding: 6 }}>
        {loading ? (
          <div style={muted}>Loading…</div>
        ) : error ? (
          <div style={{ ...muted, color: 'var(--error)' }}>{error}</div>
        ) : entries.length === 0 ? (
          <div style={muted}>Empty folder</div>
        ) : (
          entries.map((e) => {
            const full = joinPath(path, e.name);
            const isSel = !e.isDirectory && selectedFile === full;
            return (
              <button
                key={e.name}
                data-id={e.isDirectory ? 'file-picker-dir' : 'file-picker-file'}
                onClick={() => {
                  if (e.isDirectory) void load(full);
                  else if (mode !== 'folder') setSelectedFile(full);
                }}
                style={{ ...row, background: isSel ? 'var(--accent-dim)' : 'transparent', color: e.isDirectory ? 'var(--text-primary)' : 'var(--text-secondary)' }}
              >
                {e.isDirectory
                  ? <Folder size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  : <FileText size={15} style={{ flexShrink: 0 }} />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                {isSel && <Check size={14} style={{ marginLeft: 'auto', color: 'var(--accent)', flexShrink: 0 }} />}
              </button>
            );
          })
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', marginRight: 'auto' }}>
          <input data-id="file-picker-hidden" type="checkbox" checked={showHidden} onChange={(ev) => setShowHidden(ev.target.checked)} />
          Hidden
        </label>
        <button data-id="file-picker-cancel" onClick={() => onResult(null)} style={btnSecondary}>Cancel</button>
        <button data-id="file-picker-confirm" onClick={confirm} disabled={primaryDisabled} style={{ ...btnPrimary, opacity: primaryDisabled ? 0.5 : 1, cursor: primaryDisabled ? 'default' : 'pointer' }}>
          {primaryLabel}
        </button>
      </div>
    </Modal>
  );
}

const iconBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', borderRadius: 6, textAlign: 'left', fontSize: 13, fontFamily: 'var(--font-mono)', cursor: 'pointer' };
const muted: React.CSSProperties = { padding: 16, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' };
const btnSecondary: React.CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer' };
const btnPrimary: React.CSSProperties = { padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--bg-primary)', fontSize: 13, fontWeight: 700 };
