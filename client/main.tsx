import { bootstrapApp, initClientLogger } from 'ugly-app/client';
import { requests } from '../shared/api';
import en from '../shared/lang/en';
import { stringsDef } from '../shared/strings';
import { RouterProvider, RouterView } from './router';
import './styles.css';

// Ship the studio renderer's console.error/warn + uncaught errors/rejections to
// the errorLog (→ code.ugly.bot Postgres/D1, queryable via `ugly-app errors`).
// bootstrapApp does NOT install this, so without it EVERY studio console.error —
// the DB-panel telemetry, the dev-server failure tags, all 60+ of them — was
// written to the local console and dropped, never reaching the logs. That made
// remote/other-machine failures undebuggable without a screenshot. Install first,
// before bootstrap, so even boot-time errors are captured.
initClientLogger();

bootstrapApp({
  requests,
  RouterProvider,
  render: () => (
<RouterView />
  ),
  strings: {
    defaultLang: stringsDef.defaultLang,
    langs: stringsDef.langs,
    defaultTable: en as unknown as Record<string, string>,
    loadTable: async (lang) => {
      const mod = await import(`../shared/lang/${lang}.ts`) as { default: Record<string, string> };
      return mod.default;
    },
  },
});
