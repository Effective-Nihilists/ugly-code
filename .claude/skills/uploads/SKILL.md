---
name: uploads
description: Handle file uploads via ctx.storage
user-invocable: true
---

# Uploading and Using Files

## Client → upload to temp
```ts
// In a React component
const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0]
  if (!file) return
  const tempUrl = await socket.uploadFile(file, `uploads/${file.name}`)
  // tempUrl is now usable — pass to a server function to promote
}
```

## Server → promote temp to public
```ts
app.registerFunction('saveUpload', async (ctx, input: { tempKey: string; destKey: string }) => {
  const publicUrl = await ctx.storage.moveToPublic(input.tempKey, input.destKey)
  return { publicUrl }
})
```

## Server → direct write to public (server-generated content only)
```ts
const url = await ctx.storage.put('public', 'assets/logo.png', buffer, 'image/png')
```

## Get a public URL without uploading
```ts
const url = ctx.storage.url('public', 'assets/logo.png')
```

## Rules
- Only server can write to `public` bucket
- Client uploads always go to `temp`
- `temp` files expire — promote to `public` if keeping long-term

# Notes
<!-- Claude: append observations here -->
