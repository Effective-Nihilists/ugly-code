import { nanoid } from 'nanoid';
import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  PageLayout,
  Text,
  startUglyBotLogin,
  useApp,
} from 'ugly-app/client';

// ─── Session helpers (used for the experiment / analytics demo below) ─────────

function getSessionId(): string {
  const key = 'sessionId';
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const id = nanoid();
  sessionStorage.setItem(key, id);
  return id;
}

// Lightweight HTTP RPC helper for pages that run before socket auth.
// For authenticated pages with a socket, use socket.request() instead.
async function rpc<T>(name: string, input: unknown): Promise<T> {
  const res = await fetch(`/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  const json = (await res.json()) as { result: T };
  return json.result;
}

// CTA label per experiment branch — 'cta-test' must match the experiment id
// declared in shared/experiments.ts.
function getCtaLabel(branches: Record<string, string>): string {
  if (branches['cta-test'] === 'treatment') return 'Try it free';
  return 'Get started';
}

function AuthDemoAuthenticated(): React.ReactElement {
  const app = useApp();

  async function handleLogout(): Promise<void> {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.reload();
  }

  return (
    <PageLayout
      header={
        <div>
          <a href="/" data-id="auth-demo-home-authed">
            ← Home
          </a>
        </div>
      }
    >
      <div>
        <h1>Auth Demo</h1>
        <Card>
          <p>Logged in</p>
          <pre>
            {JSON.stringify(
              {
                userId: app.userId,
                email: app.user.email,
                phone: app.user.phone,
              },
              null,
              2,
            )}
          </pre>
          <Button
            variant="secondary"
            data-id="auth-demo-logout"
            onClick={() => {
              void handleLogout();
            }}
          >
            Logout
          </Button>
        </Card>
      </div>
    </PageLayout>
  );
}

function AuthDemoUnauthenticated(): React.ReactElement {
  const sessionId = useRef(getSessionId());
  const [branches, setBranches] = useState<Record<string, string>>({});

  // initSession returns experiment branch assignments and captures SESSION_START.
  // Analytics failures must not block the UI — degrade silently.
  useEffect(() => {
    rpc<{ branches: Record<string, string> }>('initSession', {
      sessionId: sessionId.current,
    })
      .then(({ branches: b }) => {
        setBranches(b);
      })
      .catch(() => {
        // Default branch values stay in place
      });
  }, []);

  function handleCtaClick(): void {
    void rpc<{ eventId: string }>('captureEvent', {
      eventName: 'CTA_CLICK',
      sessionId: sessionId.current,
      properties: { page: 'auth-demo' },
    }).catch((_e: unknown) => undefined);

    startUglyBotLogin();
  }

  const ctaLabel = getCtaLabel(branches);

  return (
    <PageLayout
      header={
        <div>
          <a href="/" data-id="auth-demo-home-loggedout">
            ← Home
          </a>
        </div>
      }
    >
      <div>
        <h1>Auth Demo</h1>
        <Text style={{ display: 'block', marginBottom: 12 }}>
          Demonstrates ugly.bot OAuth login + session-scoped experiment
          analytics. The button label is driven by the <code>cta-test</code>{' '}
          experiment in <code>shared/experiments.ts</code>.
        </Text>
        <Card>
          <Text>You are not logged in.</Text>
          <div style={{ marginTop: 12 }}>
            <Button
              variant="primary"
              data-id="auth-demo-cta"
              onClick={handleCtaClick}
            >
              {ctaLabel}
            </Button>
          </div>
        </Card>
      </div>
    </PageLayout>
  );
}

export default function AuthDemoPage(): React.ReactElement {
  const isLoggedIn = !!(window as unknown as { __AUTH_TOKEN__?: string })
    .__AUTH_TOKEN__;
  if (isLoggedIn) return <AuthDemoAuthenticated />;
  return <AuthDemoUnauthenticated />;
}
