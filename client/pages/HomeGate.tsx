import React from 'react';
import { hasSessionCookie } from 'ugly-app/client';
import { isNativeAvailable } from 'ugly-app/native';
import { chooseHomeView } from '../lib/homeView';

// The home route.
//  • Outside the Ugly Studio browser → the landing page (what it is + install).
//  • Inside Studio, logged in → the IDE.
//  • Inside Studio, logged out → a login prompt (rare: Studio gates ugly.bot
//    login before opening the browser, and code.ugly.bot shares ugly.bot SSO).
// Native + auth are both stable at mount (login transitions reload the page),
// so a mount-time check is sufficient. Each side is lazy-loaded so a visit only
// pulls the bundle it needs (the landing page is large; the IDE pulls the
// native/agent code).
const StudioLandingPage = React.lazy(() => import('./StudioLandingPage'));
const StudioShell = React.lazy(() => import('../studio/StudioShell'));
const StudioLoginPrompt = React.lazy(() => import('./StudioLoginPrompt'));

export default function HomeGate(): React.ReactElement {
  const [view] = React.useState(() =>
    chooseHomeView({ native: isNativeAvailable(), authed: hasSessionCookie() }),
  );
  return (
    <React.Suspense fallback={null}>
      {view === 'landing' && <StudioLandingPage />}
      {view === 'shell' && <StudioShell />}
      {view === 'login' && <StudioLoginPrompt />}
    </React.Suspense>
  );
}
