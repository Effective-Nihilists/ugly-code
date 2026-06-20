# Architecture

ugly-app provides a typed full-stack framework:

- **Shared** (`shared/api.ts`, `shared/collections.ts`, `shared/dbIndexes.ts`) — single source of truth for types and config, used by both client and server
- **Server** (`server/index.ts`) — Express + WebSocket, all handlers get `ctx.userId: string`
- **Client** (`client/main.tsx`) — React SPA, `createSocket()` for typed server calls, `AppProvider` for global state

## Data flow
```
Client → socket.call('fn', input)
  → WebSocket message to server
  → Router dispatches to registerFunction handler
  → Handler uses ctx.db / ctx.storage / ctx.textGen / ctx.imageGen / ctx.log
  → Returns typed result
  → Client receives typed output
```

## Live updates
```
Server writes to MongoDB
  → MongoDB Change Stream fires on all server instances
  → Server fans out to subscribed WebSocket clients
  → Client trackDoc/trackDocs callbacks receive updated data
```
