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
  'test': definePage<{}>({ auth: false }),
  'test/ai': definePage<{}>({ auth: true }),
  'test/ui': definePage<{}>({ auth: false }),
  'test/todo': definePage<{}>({ auth: true }),
  'test/scroll': definePage<{}>({ auth: false }),
  'test/search': definePage<{}>({ auth: true }),
  'test/audio': definePage<{}>({ auth: true }),
  'test/upload': definePage<{}>({ auth: true }),
  'test/email': definePage<{}>({ auth: true }),
  'test/push': definePage<{}>({ auth: true }),
  'test/chat': definePage<{}>({ auth: true }),
  'test/three': definePage<{}>({ auth: false }),
  'test/video-room': definePage<{}>({ auth: true }),
  'test/collab': definePage<{}>({ auth: true }),
  'test/errors': definePage<{}>({ auth: true }),
  'test/worker': definePage<{}>({ auth: true }),
  'test/strings': definePage<{}>({ auth: false }),
  'test/safe-area': definePage<{}>({ auth: false }),
  'test/inspect-fixture': definePage<{
    simulate?: 'cls' | 'overlap' | 'safearea' | 'keyboard' | 'jank' | 'popup';
  }>({ auth: false }),
  'test/inspect-fixture-other': definePage<{}>({ auth: false }),
});

export type AppPages = typeof pages;
