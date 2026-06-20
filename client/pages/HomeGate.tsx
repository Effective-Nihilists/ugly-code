import React from 'react';
import { hasSessionCookie } from 'ugly-app/client';

// The home route. Logged-out visitors (no ugly.bot session) get the Ugly Studio
// landing page — what it is, plus iOS / Android / Desktop download links for the
// browser. Authenticated users get the IDE. Login transitions reload the page,
// so a mount-time cookie check is sufficient (no reactive auth needed here).
//
// Each side is lazy-loaded so a visit only pulls the bundle it needs (the
// landing page is large; the IDE pulls the native/agent code).
const StudioLandingPage = React.lazy(() => import('./StudioLandingPage'));
const CodeEditorPage = React.lazy(() => import('./CodeEditorPage'));

export default function HomeGate(): React.ReactElement {
  const [authed] = React.useState(() => hasSessionCookie());
  return (
    <React.Suspense fallback={null}>
      {authed ? <CodeEditorPage /> : <StudioLandingPage />}
    </React.Suspense>
  );
}
