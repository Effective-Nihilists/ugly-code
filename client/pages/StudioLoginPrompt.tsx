// Shown when the IDE is opened inside Ugly Studio but no ugly.bot session is
// present. Reuses the same ugly.bot OAuth popup flow as AuthDemoPage; a
// successful login reloads the page (→ HomeGate re-evaluates → StudioShell).
import React from 'react';

function openLogin(): void {
  window.open(
    `https://ugly.bot/oauth?origin=${encodeURIComponent(window.location.origin)}`,
    'ugly-bot-login',
    'width=480,height=640',
  );
  function onMessage(event: MessageEvent): void {
    if (event.origin !== 'https://ugly.bot') return;
    const data = event.data as { type?: string; code?: string } | null;
    if (!data?.type || data.type !== 'ugly-bot-oauth' || !data.code) return;
    window.removeEventListener('message', onMessage);
    void fetch('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: data.code }),
    }).then((res) => {
      if (res.ok) window.location.reload();
    });
  }
  window.addEventListener('message', onMessage);
}

export default function StudioLoginPrompt(): React.ReactElement {
  return (
    <div
      data-id="studio-login"
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        gap: 16,
        textAlign: 'center',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div>
        <div style={{ fontWeight: 800, fontSize: 22, marginBottom: 8 }}>Ugly Code</div>
        <p style={{ opacity: 0.7, maxWidth: 360, margin: '0 auto 16px' }}>
          Sign in with ugly.bot to open the IDE.
        </p>
        <button data-id="studio-login-btn" onClick={openLogin} style={{ padding: '10px 18px' }}>
          Sign in →
        </button>
      </div>
    </div>
  );
}
