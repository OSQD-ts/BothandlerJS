# Integration

Getting it into your application: frameworks, the client address, and shared state.

← [Documentation](../index.md)

---

| Page | For |
| ---- | --- |
| [Adapters](adapters.md) | Express, Fastify, Koa, Fetch runtimes, Hono, Next.js — and writing your own |
| [The client IP](client-ip.md) | the highest-consequence setting in the library |
| [Stores](stores.md) | what needs to be shared across replicas, and what deliberately is not |

---

## The shape of it

Three lines in the common case:

```ts
import { BotHandler } from "@osqd/bothandlerjs";
import { botHandler } from "@osqd/bothandlerjs/adapters";

const detector = new BotHandler({ preset: "protect-content" });
app.use(botHandler(detector));
```

One `BotHandler` instance per policy, mounted where that policy applies. Most applications
have one; an application that runs [`protect-auth`](../policy/presets.md) on its login
routes has two.

## The one thing to get right before anything else

**The client address.** It becomes the [actor key](../concepts/actors.md), which every
behavioural detector, every rate limit and every allowlist entry depends on. Behind a proxy
it has no safe default, and getting it wrong turns every per-actor mechanism here into an
attacker input.

Read [the client IP](client-ip.md) before you deploy this behind anything.

## Two guarantees the integration relies on

**The engine never touches a response object.** It returns an `ActionOutcome` and the
adapter applies it — which is why the same policy behaves identically on Express and on a
Worker, and why writing your own adapter is about thirty lines.

**It fails open.** An unexpected failure inside detection serves the request. The error
goes to your `onError`; the visitor gets their page. A bot filter that fails closed is an
outage with extra steps.

## Related

- [Configuration reference](../reference/configuration.md) — every option
- [First integration](../start/first-integration.md) — the walk-through
