# Collections

Collections are defined in `shared/collections.ts` and passed to `createApp()`.

## Flags

- `trackable: true` — clients can `trackDoc` / `trackDocs` on this collection
- `public: true` — unauthenticated users can read (future: not yet enforced)
- `cache: false` — disable client-side caching (reserved for future use)
- `parent: 'collectionName'` — denotes a sub-collection relationship

## Indexes

Indexes are defined directly on the collection definition in `shared/collections.ts`:

```ts
export const collections = defineCollections({
  post: {
    type: {} as Post,
    meta: { cache: true, trackable: true, public: false, cascadeFrom: null },
    indexes: [
      { fields: { authorId: 1, created: -1 } },  // regular index
    ],
  },
});
```

After adding or modifying indexes:
1. Run `npm run db:schema-gen` to generate a migration file
2. Run `npm run db:migrate` to apply the migration
