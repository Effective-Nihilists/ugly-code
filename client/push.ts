/**
 * Push notification helpers for projects deployed on ugly.bot.
 *
 * Registration happens via a hidden iframe on ugly.bot (which owns the
 * service worker and Firebase credentials). Projects only need their
 * project token (window.__AUTH_TOKEN__) to authenticate.
 *
 * Usage:
 *   import { initPush, requestPushPermission } from './push';
 *
 *   // Check status (call once on app load)
 *   const { registered } = await initPush();
 *
 *   // Prompt user if not registered
 *   if (!registered) await requestPushPermission();
 */

const _UGLY_BOT = (window as unknown as Record<string, string>).__UGLY_BOT_URL__ ?? 'https://ugly.bot';
const PUSH_FRAME_URL = `${_UGLY_BOT}/push-frame`;
const PUSH_FRAME_ORIGIN = _UGLY_BOT;

let iframe: HTMLIFrameElement | null = null;
let iframeReady = false;
let pendingResolvers: {
  func: string;
  resolve: (data: Record<string, unknown>) => void;
}[] = [];

function getToken(): string {
  return (window as unknown as { __AUTH_TOKEN__?: string }).__AUTH_TOKEN__ ?? '';
}

function ensureIframe(): Promise<void> {
  if (iframe && iframeReady) return Promise.resolve();
  return new Promise((resolve) => {
    if (iframe) {
      const prev = iframe.onload;
      iframe.onload = (e) => {
        if (typeof prev === 'function') prev.call(iframe!, e);
        iframeReady = true;
        resolve();
      };
      return;
    }

    iframe = document.createElement('iframe');
    iframe.src = PUSH_FRAME_URL;
    iframe.style.display = 'none';
    iframe.onload = () => {
      iframeReady = true;
      resolve();
    };
    document.body.appendChild(iframe);

    window.addEventListener('message', (event) => {
      if (event.origin !== PUSH_FRAME_ORIGIN) return;
      const data = event.data as Record<string, unknown>;
      const func = data.func as string;
      const idx = pendingResolvers.findIndex((r) => r.func === func);
      if (idx >= 0) {
        pendingResolvers[idx]!.resolve(data);
        pendingResolvers.splice(idx, 1);
      }
    });
  });
}

function postAndWait(
  msg: Record<string, unknown>,
  expectFunc: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = pendingResolvers.findIndex((r) => r.func === expectFunc);
      if (idx >= 0) pendingResolvers.splice(idx, 1);
      reject(new Error(`push-frame timeout waiting for "${expectFunc}"`));
    }, timeoutMs);

    pendingResolvers.push({
      func: expectFunc,
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
    });
    iframe!.contentWindow!.postMessage(msg, PUSH_FRAME_ORIGIN);
  });
}

/**
 * Initialize push — loads the iframe and checks registration status.
 * Returns { registered: boolean }.
 */
export async function initPush(): Promise<{ registered: boolean }> {
  const token = getToken();
  if (!token) return { registered: false };

  await ensureIframe();
  const result = await postAndWait(
    { func: 'pushInit', authToken: token },
    'pushStatus',
  );
  return { registered: result.registered as boolean };
}

/**
 * Request push notification permission and register.
 * The browser will show the notification permission prompt.
 * Resolves when registration is complete.
 */
export async function requestPushPermission(): Promise<{
  success: boolean;
  error?: string;
}> {
  const token = getToken();
  if (!token) return { success: false, error: 'no_token' };

  await ensureIframe();

  const successPromise = new Promise<{ success: boolean; error?: string }>(
    (resolve) => {
      pendingResolvers.push({
        func: 'pushRegistered',
        resolve: () => { resolve({ success: true }); },
      });
    },
  );
  const errorPromise = new Promise<{ success: boolean; error?: string }>(
    (resolve) => {
      pendingResolvers.push({
        func: 'pushError',
        resolve: (data) => {
          resolve({ success: false, error: data.error as string });
        },
      });
    },
  );

  iframe!.contentWindow!.postMessage(
    { func: 'pushRequestPermission', authToken: token },
    PUSH_FRAME_ORIGIN,
  );

  const result = await Promise.race([successPromise, errorPromise]);
  pendingResolvers = pendingResolvers.filter(
    (r) => r.func !== 'pushRegistered' && r.func !== 'pushError',
  );
  return result;
}
