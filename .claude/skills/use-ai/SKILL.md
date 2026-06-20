---
name: use-ai
description: Use text and image generation in handlers
user-invocable: true
---

# Using Text and Image Generation

## Text generation (llama4)
```ts
app.registerFunction('generateText', async (ctx, input: { prompt: string }) => {
  const text = await ctx.textGen.generate([
    { role: 'user', content: input.prompt }
  ])
  return { text }
})
```

## With system prompt
```ts
const text = await ctx.textGen.generate(messages, {
  systemPrompt: 'You are a helpful assistant.',
  maxTokens: 512,
  temperature: 0.7,
})
```

## Image generation (flux schnell) — returns temp URL
```ts
app.registerFunction('generateImage', async (ctx, input: { prompt: string }) => {
  const tempUrl = await ctx.imageGen.generate(input.prompt)
  // Promote to public if keeping permanently:
  // const publicUrl = await ctx.storage.moveToPublic('imagegen/xxx.png', 'assets/xxx.png')
  return { url: tempUrl }
})
```

## Spend limits
- Budget set via `AI_MAX_SPEND_PER_HOUR` env var (default $1.00/hr)
- Calls over budget are queued (max 5 min wait) then execute when window clears
- If queue is full (100 calls), throws `SpendLimitError` — show user a friendly message

## Check current spend
```bash
mongosh "$MONGODB_URI" --eval "
const since = new Date(Date.now() - 3600000);
db.aiSpend.aggregate([
  { \$match: { created: { \$gte: since } } },
  { \$group: { _id: '\$model', total: { \$sum: '\$costUsd' } } }
]).pretty()
"
```

# Notes
<!-- Claude: append observations here -->
