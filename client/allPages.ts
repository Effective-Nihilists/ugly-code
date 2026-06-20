import { lazyPage } from 'ugly-app/client';
import type { PageMap } from 'ugly-app/shared';
import type { AppPages } from '../shared/pages';

// ─── Page Map ─────────────────────────────────────────────────────────────────
// Maps every route key defined in shared/pages.ts to a lazy-loaded component.
// The `satisfies PageMap<AppPages>` ensures keys stay in sync at compile time.
//
// lazyPage(() => import('./pages/MyPage'))
//   – code-splits the page into its own chunk, loaded on first navigation
//
// For pages that need a custom loader (data fetching before render), use
// lazyPageLoader() instead and export a `loader` function from the page file.
//
// When you add a route in shared/pages.ts, add the matching entry here.
export const allPages = {
  ['']: lazyPage(() => import('./pages/HomePage')),
  ['auth-demo']: lazyPage(() => import('./pages/AuthDemoPage')),
  ['user/:userId']: lazyPage(() => import('./pages/UserPage')),
  ['search']: lazyPage(() => import('./pages/SearchPage')),
  ['test']: lazyPage(() => import('./pages/TestIndexPage')),
  ['test/ai']: lazyPage(() => import('./pages/AITestPage')),
  ['test/ui']: lazyPage(() => import('./pages/UIComponentsPage')),
  ['test/todo']: lazyPage(() => import('./pages/TodoDemoPage')),
  ['test/scroll']: lazyPage(() => import('./pages/ScrollTestPage')),
  ['test/search']: lazyPage(() => import('./pages/KagiTestPage')),
  ['test/audio']: lazyPage(() => import('./pages/AudioTestPage')),
  ['test/upload']: lazyPage(() => import('./pages/UploadTestPage')),
  ['test/email']: lazyPage(() => import('./pages/EmailTestPage')),
  ['test/push']: lazyPage(() => import('./pages/PushTestPage')),
  ['test/chat']: lazyPage(() => import('./pages/ChatTestPage')),
  ['test/three']: lazyPage(() => import('./pages/ThreeTestPage')),
  ['test/video-room']: lazyPage(() => import('./pages/VideoRoomTestPage')),
  ['test/collab']: lazyPage(() => import('./pages/CollabTestPage')),
  ['test/errors']: lazyPage(() => import('./pages/ErrorTestPage')),
  ['test/worker']: lazyPage(() => import('./pages/WorkerTestPage')),
  ['test/strings']: lazyPage(() => import('./pages/StringsTestPage')),
  ['test/safe-area']: lazyPage(() => import('./pages/SafeAreaTestPage')),
  ['test/inspect-fixture']: lazyPage(() => import('./pages/InspectFixturePage')),
  ['test/inspect-fixture-other']: lazyPage(
    () => import('./pages/InspectFixtureOtherPage'),
  ),
} satisfies PageMap<AppPages>;
