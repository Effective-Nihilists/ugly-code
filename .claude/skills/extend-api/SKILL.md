---
name: extend-api
description: Add new server functions or requests to the API
user-invocable: true
---

# Extending the API

Use this skill when adding new server functions or requests.

## Steps

1. **Add to `shared/api.ts`**
```ts
export const functions = defineFunctions({
  // existing...
  myNewFunction: {} as FunctionDef<{ param: string }, { result: string }>,
})
```

2. **Register the handler in `server/index.ts`**
```ts
app.registerFunction('myNewFunction', async (ctx, input) => {
  // input: { param: string } — fully typed
  // ctx.userId, ctx.db, ctx.storage, ctx.textGen, ctx.imageGen, ctx.log
  return { result: `Hello ${input.param}` }
})
```

3. **Call from client**
```ts
const { result } = await socket.call('myNewFunction', { param: 'world' })
```

4. **For read-only operations**, use `defineRequests` + `app.registerRequest` + `socket.request()` instead.

## Rules
- Functions = mutating (writes, AI calls, side effects) → `call()`
- Requests = read-only → `request()`
- Both always have `ctx.userId: string`

# Notes
<!-- Claude: append observations here -->
