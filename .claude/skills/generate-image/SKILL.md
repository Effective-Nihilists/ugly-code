---
name: generate-image
description: Generate images using imageGen from CLI or in request handlers
user-invocable: true
---

# Generating Images

## From the CLI
```bash
# Generate an image and get the URL
npm run imageGen -- "a sunset over mountains"

# Save directly to a file
npm run imageGen -- "a sunset over mountains" --output client/assets/sunset.png

# Specify a model
npm run imageGen -- "a sunset" --model flux_1_dev
```

Requires `ugly-app login` first.

## In a request handler
```ts
import { createImageGen } from 'ugly-app';

// In a handler:
const url = await createImageGen(userId).generate(prompt, { model: 'flux_1_schnell' });
return { url };
```

## Saving generated images as permanent assets
The CLI `--output` flag saves directly to disk. In handlers, generated URLs are temporary — promote to permanent storage:
```ts
const tempUrl = await createImageGen(userId).generate(prompt);
// Download and save to public assets:
const response = await fetch(tempUrl);
const buffer = Buffer.from(await response.arrayBuffer());
fs.writeFileSync('client/assets/generated.png', buffer);
```

Or use ctx.storage to promote to a public bucket:
```ts
const publicUrl = await ctx.storage.moveToPublic(tempKey, 'assets/name.png');
```

## Available models
- `flux_1_schnell` — fast, default
- `flux_1_dev` — higher quality
- `flux_1_pro` — premium quality

## Notes
- Requires `ugly-app login` (authenticates with ugly.bot)
- CLI reads token from `~/.ugly-bot/auth.json`
- Generated URLs are temporary — save to file or storage for permanence
- Budget set via `AI_MAX_SPEND_PER_HOUR` env var (default $1.00/hr) on server side

# Notes
<!-- Claude: append observations here -->
