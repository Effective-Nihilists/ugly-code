import { defineStrings } from 'ugly-app/shared';

// ─── App string table ────────────────────────────────────────────────────────
// Every user-facing string in the app belongs here.
// Framework-provided strings (loading, cancel, save, etc.) are merged automatically.

export interface AppStringTable {
  appName: string;
  welcome: string;
  welcomeBack: string;
  getStarted: string;
  login: string;
  logout: string;
  testPages: string;
}

// ─── Supported languages ─────────────────────────────────────────────────────

export type AppLang = 'en' | 'es';

// ─── Definition ──────────────────────────────────────────────────────────────

export const stringsDef = defineStrings<AppStringTable, AppLang>({
  defaultLang: 'en',
  langs: ['en', 'es'] as const,
});
