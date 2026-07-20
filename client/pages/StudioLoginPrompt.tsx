// Shown when the IDE is opened inside Ugly Studio but no ugly.bot session is
// present. Reuses the same ugly.bot OAuth popup flow as AuthDemoPage; a
// successful login reloads the page (→ HomeGate re-evaluates → StudioShell).
import React from 'react';
import { startUglyBotLogin } from 'ugly-app/client';

export default function StudioLoginPrompt(): React.ReactElement {
  return (
    <div
      data-id="studio-login"
      className="safe-area"
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        gap: 16,
        padding: '0 20px',
        boxSizing: 'border-box',
        textAlign: 'center',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div style={{ fontWeight: 800, fontSize: 22, marginBottom: 8 }}>
          Ugly Code
        </div>
        <p style={{ opacity: 0.7, maxWidth: 360, margin: '0 auto 16px' }}>
          Sign in with ugly.bot to open the IDE.
        </p>
        <button
          data-id="studio-login-btn"
          onClick={() => {
            startUglyBotLogin();
          }}
          style={{ padding: '10px 18px' }}
        >
          Sign in →
        </button>
      </div>
    </div>
  );
}
