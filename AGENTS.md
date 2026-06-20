# Agent pointer

This is an **ugly-app child app**. It has no `docker-compose.yml` and no `.env`. Infra (Postgres, NATS, storage, vector search) is provisioned by ugly.bot and reached over a WebSocket called the DataProxy.

Before doing infra / data / migration work:

1. **Run `npx ugly-app doctor`** — single-command diagnostic. It reports `.uglyapp` state, auth token presence, DataProxy connectivity, and pending migrations, plus the obvious next step.
2. **Read `node_modules/ugly-app/AGENTS.md`** — the framework's own agent guide. Covers the config model, CLI catalog, seed-script pattern (`bootstrapInfra()`), and common failure modes.

Everything a human or LLM agent needs to know about the framework is in those two places. Prefer them over grepping `node_modules/ugly-app/dist` source.
