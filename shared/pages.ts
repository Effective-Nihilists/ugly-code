import { definePage, definePages } from 'ugly-app/shared';

// ─── Pages ────────────────────────────────────────────────────────────────────
// Define every route your app supports here. Each key is a URL path segment.
//
// definePage<Params>(options)
//   Params  – TypeScript type for URL params (path + query string)
//   auth    – require authentication? (default: true)
//
// Path params use Express-style syntax:  'user/:userId'
// Query params are declared in the type but not the key: definePage<{ q?: string }>
//
// After adding a page here, map it to a component in client/allPages.ts.
// Navigate to it from anywhere via: useRouter().push('route-key', params)
export const pages = definePages({
  '': definePage<{}>({ auth: false }),
  'auth-demo': definePage<{}>({ auth: false }),
  'user/:userId': definePage<{ userId: string }>(),
  'search': definePage<{ q?: string }>({ auth: false }),
  // Kept as UX-inspection fixtures driven by tests/e2e (scroll + inspect).
  'test/scroll': definePage<{}>({ auth: false }),
  'test/inspect-fixture': definePage<{
    simulate?: 'cls' | 'overlap' | 'safearea' | 'keyboard' | 'jank' | 'popup';
  }>({ auth: false }),
  'test/inspect-fixture-other': definePage<{}>({ auth: false }),
  // Mounts the real <AgentPanel/> so e2e can drive the coding-agent loop
  // (deterministic via a scripted step override + UglyNative mock, or real via
  // an injected auth cookie). See tests/e2e/agent.spec.ts.
  'test/agent': definePage<{}>({ auth: false }),
});

export type AppPages = typeof pages;
