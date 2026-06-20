# DB Queries

All DB operations are available on `ctx.db` in server handlers.

## Read

```ts
const doc = await ctx.db.getDoc(collections.post, id)           // returns T | null
const posts = await ctx.db.getDocs(collections.post, { authorId: ctx.userId })  // equality filter
```

## Write

```ts
await ctx.db.setDoc(collections.post, { ...dbDefaults(), id: nanoid(), title, authorId: ctx.userId })
await ctx.db.setDocFields(collections.post, id, { title: newTitle })  // partial update
await ctx.db.deleteDoc(collections.post, id)
```

## dbDefaults()

Always spread `dbDefaults()` when creating new docs:
```ts
import { dbDefaults } from 'ugly-app/shared'
{ ...dbDefaults(), id: nanoid(), ...yourFields }
```

Adds: `created: new Date()`, `updated: new Date()`.

## Live updates (client)

```ts
// Single doc
const unsub = socket.trackDoc<Post>('post', postId, (post) => setPost(post))

// Collection with filter
const unsub = socket.trackDocs<Post>('post', { authorId: userId }, (posts) => setPosts(posts))

// Cleanup
return () => unsub()
```
