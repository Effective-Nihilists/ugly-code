import { useCallback, useEffect, useRef } from 'react';
import { useSocket } from './useSocket';
import {
  getStudioUserSettingSync,
  setStudioUserSetting,
} from './useStudioUserSetting';

const MAX_HISTORY = 100;

/**
 * Per-tab textarea history (↑/↓ to recall prior submissions).
 *
 * The `storageKey` parameter is now a logical key into the
 * `~/.ugly-studio/settings.json` map (not a `localStorage` key) —
 * callers pass a stable per-input identifier and this hook routes
 * reads/writes through `studioUserSettings`. Caller-side keys keep
 * the `inputHistory:` prefix convention so settings are easy to
 * inspect by hand in the JSON file.
 */
export function useInputHistory(
  storageKey: string,
  input: string,
  setInput: (v: string) => void,
) {
  const socket = useSocket();
  const historyRef = useRef<string[]>([]);
  const pointerRef = useRef<number>(0);
  const lastRecalledRef = useRef<string | null>(null);

  useEffect(() => {
    const raw = getStudioUserSettingSync<unknown>(storageKey);
    if (Array.isArray(raw)) {
      historyRef.current = raw.filter((x) => typeof x === 'string');
    } else {
      historyRef.current = [];
    }
    pointerRef.current = historyRef.current.length;
  }, [storageKey]);

  const persist = useCallback(() => {
    setStudioUserSetting(socket, storageKey, historyRef.current);
  }, [storageKey, socket]);

  const push = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) return;
      const h = historyRef.current;
      if (h[h.length - 1] !== v) {
        h.push(v);
        if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
        persist();
      }
      pointerRef.current = h.length;
      lastRecalledRef.current = null;
    },
    [persist],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
      const h = historyRef.current;
      if (h.length === 0) return false;

      // Only activate when input is empty or matches the last recalled entry —
      // otherwise let arrow keys move the caret normally in user-typed text.
      const isRecalled =
        lastRecalledRef.current !== null && input === lastRecalledRef.current;
      if (input !== '' && !isRecalled) return false;

      if (e.key === 'ArrowUp') {
        if (pointerRef.current <= 0) {
          e.preventDefault();
          return true;
        }
        pointerRef.current -= 1;
        const value = h[pointerRef.current];
        lastRecalledRef.current = value;
        setInput(value);
        e.preventDefault();
        return true;
      }

      // ArrowDown
      if (pointerRef.current >= h.length) return false;
      pointerRef.current += 1;
      if (pointerRef.current === h.length) {
        lastRecalledRef.current = null;
        setInput('');
      } else {
        const value = h[pointerRef.current];
        lastRecalledRef.current = value;
        setInput(value);
      }
      e.preventDefault();
      return true;
    },
    [input, setInput],
  );

  return { push, onKeyDown };
}
