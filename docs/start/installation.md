# Installation

← [Documentation](../index.md) · [Getting started](../index.md)

---

```bash
npm install bothandlerjs
```

**Node 18 or later.** ESM and CJS builds, TypeScript declarations included.

## Zero runtime dependencies

The library imports nothing but `node:` builtins, and CI fails if that ever stops being
true. Nothing here can hand your project a transitive advisory, an install script, or a
version conflict with something you already run.

Redis, if you use it, is your client passed in: `RedisStore` describes the five commands it
needs structurally and imports neither `ioredis` nor `node-redis`.

```ts
import { RedisStore } from "bothandlerjs";
new BotHandler({ store: new RedisStore(redis) });
```

## The entry points

| Import | Contains |
| ------ | -------- |
| `bothandlerjs` | the engine, detectors, presets, robots, stores, notifiers, challenge, dashboard |
| `bothandlerjs/adapters` | [Express, Fastify, Koa, Fetch](../integration/adapters.md) |
| `bothandlerjs/client` | the browser-side [client signals](../detection/client-signals.md) script |
| `bothandlerjs/corpus` | [`runCorpus`](../testing/corpus.md) and all 526 cases |
| `bothandlerjs/cli` | the [command line](../testing/cli.md) |

## Runtimes

| Runtime | Notes |
| ------- | ----- |
| Node 18+ | everything works |
| Bun, Deno | use the [Fetch adapter](../integration/adapters.md) |
| Cloudflare Workers | enable `nodejs_compat` — the engine uses `node:crypto` |
| Vercel Edge, Netlify Edge | Fetch adapter; set `clientIp` explicitly |

On every Fetch runtime, two things differ. There is no socket, so the client address comes
from a header — read [the client IP](../integration/client-ip.md) before you deploy. And
header order is normalised, so `header-order` returns nothing there; drop it.

## Without installing anything

Every CLI command runs through `npx`:

```bash
npx bothandlerjs explain "curl/8.4.0"
npx bothandlerjs check --preset protect-content
npx bothandlerjs replay /var/log/nginx/access.log
```

## Next

- [Your first integration](first-integration.md)
- [Choosing a policy](choosing-a-policy.md)
