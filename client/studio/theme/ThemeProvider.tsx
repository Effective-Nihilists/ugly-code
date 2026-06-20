import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  useStudioUserSetting,
  useStudioUserSettingsHydrated,
} from '../hooks/useStudioUserSetting';

export type ThemeChoice = 'auto' | 'light' | 'dark' | 'cosmic-latte' | 'vim';
export type ResolvedTheme = 'light' | 'dark' | 'cosmic-latte' | 'vim';
export type ThemeMode = 'light' | 'dark';

export const THEME_OPTIONS: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'cosmic-latte', label: 'Cosmic Latte' },
  { value: 'vim', label: 'Vim' },
];

export const THEME_CYCLE: ThemeChoice[] = [
  'auto',
  'light',
  'dark',
  'cosmic-latte',
  'vim',
];

interface ThemeContextValue {
  theme: ThemeChoice;
  setTheme: (next: ThemeChoice) => void;
  cycleTheme: () => void;
  resolved: ResolvedTheme;
  mode: ThemeMode;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemMode(): ThemeMode {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [theme, setTheme] = useStudioUserSetting<ThemeChoice>('theme', 'auto');
  // Before the settings cache hydrates, `theme` is the default 'auto'
  // — NOT the user's stored value. Resolving 'auto' against systemMode
  // and writing it to <html> would clobber the correct value index.html
  // already painted from the `?theme=` URL query param (Electron passes
  // the resolved theme straight from settings.json into the URL). When
  // the cache then hydrates and theme flips to the real choice, the
  // useEffect re-runs and corrects the attribute — that's the flash.
  // Gate the dataset.theme write on hydration so first paint stays
  // whatever index.html already set.
  const hydrated = useStudioUserSettingsHydrated();
  const [systemMode, setSystemMode] = useState<ThemeMode>(getSystemMode);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent): void => {
      setSystemMode(e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const resolved: ResolvedTheme = useMemo(() => {
    if (theme === 'auto') return systemMode;
    return theme;
  }, [theme, systemMode]);

  const mode: ThemeMode = useMemo(() => {
    if (resolved === 'dark' || resolved === 'vim') return 'dark';
    return 'light';
  }, [resolved]);

  useEffect(() => {
    // Don't write before hydration — see the comment on `hydrated`
    // above. index.html already painted the correct theme from
    // `?theme=`; let it stand until we have the real user setting.
    if (!hydrated) return;
    document.documentElement.dataset.theme = resolved;
    // Mirror the resolved theme into localStorage so the inline script in
    // index.html can paint the right palette before this React tree boots
    // on the next launch.
    try {
      localStorage.setItem('studio-theme-cache', resolved);
    } catch {
      /* private mode / quota — fine, just no first-paint cache next time */
    }
    // Intentionally NO cleanup function: useEffect cleanups run BEFORE
    // the next effect on dependency changes, which would briefly strip
    // `data-theme` from <html> and flash the default-light CSS in
    // between. Setting `dataset.theme` again on the next effect run
    // overwrites the old value atomically — no intermediate state to
    // clean up.
  }, [resolved, hydrated]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      cycleTheme: () => {
        const idx = THEME_CYCLE.indexOf(theme);
        const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
        setTheme(next);
      },
      resolved,
      mode,
    }),
    [theme, setTheme, resolved, mode],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    return {
      theme: 'auto',
      setTheme: () => undefined,
      cycleTheme: () => undefined,
      resolved: getSystemMode(),
      mode: getSystemMode(),
    };
  }
  return ctx;
}

export function useResolvedTheme(): {
  resolved: ResolvedTheme;
  mode: ThemeMode;
} {
  const { resolved, mode } = useTheme();
  return { resolved, mode };
}
