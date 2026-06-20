import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Slash-command / skill autocomplete hook shared by ClaudeChat and CodingAgentChat.
 *
 * Trigger: input matches `^/[\w-]*$` (whole-input prefix only — no mid-
 * message hijacking). When triggered, the popup lists skills fetched
 * from `/api/listSkills`, filtered by what follows the `/`.
 *
 * Navigation: ArrowUp/Down move selection, Enter/Tab select, Esc closes.
 * When a skill is selected, the input is replaced with
 *   `Use the \`<name>\` skill`
 * and the caret is placed at the end so the user can append parameters
 * before sending.
 */

export interface Skill {
  name: string;
  description: string;
  scope: 'user' | 'project' | 'command';
  /** 'skill' (default) — inserts a `/skill-name` pill that gets prepended
   *  to the outgoing message. 'command' — built-in local action (e.g.
   *  `/clear`) that the panel handles directly on select. */
  kind?: 'skill' | 'command';
}

/** Built-in slash commands surfaced in the popup alongside skills. */
const BUILTIN_COMMANDS: Skill[] = [
  {
    name: 'clear',
    description: 'Clear conversation and start a new chat',
    scope: 'command',
    kind: 'command',
  },
];

// Module-level cache so switching between panels doesn't re-fetch.
let cachedSkills: Skill[] | null = null;
let inflight: Promise<Skill[]> | null = null;

async function fetchSkills(): Promise<Skill[]> {
  if (cachedSkills) return cachedSkills;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/listSkills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ input: {} }),
      });
      const json = await res.json();
      const skills = (json.result?.skills ?? json.skills ?? []) as Skill[];
      cachedSkills = skills;
      return skills;
    } catch {
      cachedSkills = [];
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Invalidate cache — call this when skills on disk may have changed. */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export interface UseSlashCommandsResult {
  popupOpen: boolean;
  filtered: Skill[];
  selectedIdx: number;
  /** Call from textarea onChange. Returns the (possibly unchanged) input string. */
  handleChange: (value: string) => void;
  /** Call from textarea onKeyDown. Returns true if the key was consumed. */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Close the popup (e.g. on blur). */
  close: () => void;
  /** Set the selected item directly (used by popup hover). */
  setSelectedIdx: (idx: number) => void;
}

export function useSlashCommands(opts: {
  input: string;
  setInput: (value: string) => void;
  /** Called when the user picks an item (click OR Tab/Enter in the
   *  popup). Panels use this to dispatch built-in commands and set
   *  pending-skill pills. If omitted, the hook falls back to writing
   *  `Use the \`<name>\` skill` into the input. */
  onSelect?: (skill: Skill) => void;
}): UseSlashCommandsResult {
  const { input, setInput, onSelect } = opts;
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [popupOpen, setPopupOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const latestInput = useRef(input);
  latestInput.current = input;

  useEffect(() => {
    let cancelled = false;
    void fetchSkills().then((s) => {
      if (!cancelled) setSkills(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Derive query from current input (only when it matches `^/[\w-]*$`).
  const query = useMemo(() => {
    const m = /^\/([\w-]*)$/.exec(input);
    return m ? m[1] : null;
  }, [input]);

  const filtered = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    // Built-in commands go first and shadow any disk skill with the same
    // name — `/clear` must always resolve to the built-in, never a user
    // skill that happens to be named "clear".
    const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
    const merged = [
      ...BUILTIN_COMMANDS,
      ...skills.filter((s) => !builtinNames.has(s.name)),
    ];
    return merged.filter((s) => s.name.toLowerCase().includes(q));
  }, [query, skills]);

  // Auto-open/close + reset selection as the query changes.
  useEffect(() => {
    if (query === null) {
      setPopupOpen(false);
      setSelectedIdx(0);
    } else {
      setPopupOpen(true);
      setSelectedIdx(0);
    }
  }, [query]);

  const applySelection = useCallback(
    (skill: Skill) => {
      setPopupOpen(false);
      if (onSelectRef.current) {
        onSelectRef.current(skill);
        return;
      }
      // Legacy fallback: write a prompt-friendly reference into the input.
      setInput(`Use the \`${skill.name}\` skill `);
    },
    [setInput],
  );

  const handleChange = useCallback((_value: string) => {
    // The effect on `query` handles popup open/close; this function
    // exists for symmetry so both chat panels can call it uniformly.
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!popupOpen || filtered.length === 0) {
        // Nothing to navigate — but if the user pressed Enter on a `/` with
        // zero matches, we still swallow Enter so it doesn't fire the send.
        if (popupOpen && (e.key === 'Enter' || e.key === 'Escape')) {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setPopupOpen(false);
            return true;
          }
        }
        return false;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          setSelectedIdx((i) => (i + 1) % filtered.length);
          return true;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          setSelectedIdx((i) => (i - 1 + filtered.length) % filtered.length);
          return true;
        case 'Enter':
        case 'Tab': {
          e.preventDefault();
          e.stopPropagation();
          const choice = filtered[selectedIdx] ?? filtered[0];
          if (choice) applySelection(choice);
          return true;
        }
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          setPopupOpen(false);
          return true;
        default:
          return false;
      }
    },
    [popupOpen, filtered, selectedIdx, applySelection],
  );

  const close = useCallback(() => setPopupOpen(false), []);

  return {
    popupOpen: popupOpen && (filtered.length > 0 || query !== null),
    filtered,
    selectedIdx,
    handleChange,
    handleKeyDown,
    close,
    setSelectedIdx,
  };
}
