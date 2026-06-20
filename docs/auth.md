# Authentication

ugly-app handles auth via HttpOnly cookie + server-side JWT injection. No localStorage needed.

## How it works

1. User logs in via ugly.bot OAuth popup → `POST /auth/verify` → server sets `auth_token` HttpOnly cookie
2. On every page load, the server reads the cookie, issues a **fresh 30-day token**, and injects it into the HTML:
   ```html
   <script>window.__AUTH_TOKEN__ = "eyJ..."</script>
   ```
3. Client reads `window.__AUTH_TOKEN__` synchronously — no extra HTTP round-trip
4. Token is passed to `socket.connect(token)` for WebSocket authentication

## Endpoints (provided by ugly-app)

- `POST /auth/verify` — exchanges OAuth code for JWT, sets `auth_token` cookie
- `GET /auth/token` — validates cookie, returns `{ token }`, refreshes cookie (useful for SPAs making background requests)
- `POST /auth/logout` — clears the `auth_token` cookie
- `GET /auth/url` — returns the OAuth popup URL for a given origin

## Client pattern

```tsx
// Read token injected by server (set once, valid for whole session)
const token = (window as any).__AUTH_TOKEN__

// Logout
await fetch('/auth/logout', { method: 'POST' })
window.location.reload()
```

## Server handlers

All handlers receive `ctx.userId: string` (guaranteed authenticated).
Lazy `ctx.user: Promise<User | null>` for full user object when needed.

## Token expiry

Default: 30 days. Refreshed on every page load. Override via `JWT_EXPIRY_SECONDS` env var.
