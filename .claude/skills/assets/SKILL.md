---
name: assets
description: Manage static assets and generated images
user-invocable: true
---

# Managing Static Assets

## Static assets (images, fonts, icons)
Place in `client/assets/` — Vite serves them at `/assets/filename.ext`

```tsx
// Reference in React
<img src="/assets/logo.png" alt="Logo" />
```

## Generating assets with imageGen
```ts
app.registerFunction('createAsset', async (ctx, input: { prompt: string; name: string }) => {
  // Generate image
  const tempUrl = await ctx.imageGen.generate(input.prompt)
  // Extract temp key from URL
  const tempKey = tempUrl.split('/temp/')[1]
  // Promote to public assets
  const publicUrl = await ctx.storage.moveToPublic(tempKey, `assets/${input.name}.png`)
  return { publicUrl }
})
```

## Recommended asset organization
```
client/assets/
  icons/        — UI icons
  backgrounds/  — Background images
  generated/    — imageGen output (promoted to public bucket)
public/         — Static files served at root (favicon.ico, robots.txt)
```

## Image sizes for flux schnell
- Default: 1024×1024
- Banners: use prompt guidance ("wide landscape format", "16:9 ratio")
- Icons: generate at 1024×1024, scale down in CSS

# Notes
<!-- Claude: append observations here — record generated asset URLs -->
