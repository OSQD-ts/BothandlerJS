# Lesson 12 — Going live

**Goal:** mount Serif behind a real framework, and get the one setting right that is
dangerous to get wrong.

← [Course](index.md) · Prev: [The challenge](11-the-challenge.md) · Next: [Operating it](13-operating-it.md)

---

## Three lines

```js
import { BotHandler } from "@osqd/bothandlerjs";
import { botHandler } from "@osqd/bothandlerjs/adapters";

const detector = new BotHandler({ preset: "monitor-only" });
app.use(botHandler(detector));
```

Four adapters ship:

```js
import { botHandler, fastifyBotHandler, koaBotHandler, withBotHandler } from "@osqd/bothandlerjs/adapters";

app.use(botHandler(detector));                                  // Express / Connect / node:http
fastify.addHook("onRequest", fastifyBotHandler(detector));
app.use(koaBotHandler(detector));
export default { fetch: withBotHandler(detector, myHandler) };  // Workers / Deno / Bun / Edge
```

**Hono and Next.js need no adapter of their own.** Both speak the platform's `Request` and
`Response`, which is what `createFetchAdapter` takes and returns:

```js
const guard = createFetchAdapter(detector, { ipHeaders: ["cf-connecting-ip"] });

// Hono
app.use(async (c, next) => {
  const decision = await guard(c.req.raw, c.env);
  if (decision.response) return decision.response;
  await next();
});

// Next.js — middleware.ts
export async function middleware(request) {
  const decision = await guard(request);
  if (decision.response) return decision.response;
  return NextResponse.next({ request: { headers: decision.request.headers } });
}
```

Passing `decision.request.headers` on is the part worth doing: it carries the verdict to
routes further in, so they need not assess anything themselves.

## Why the engine never touches a response

`handle` returns an `ActionOutcome` — `continue`, `respond`, or `drop` — and the adapter
applies it. That is why the same policy behaves identically on Express and on a Worker, why
`assess` is safe to run over a log file, and why writing your own adapter is about thirty
lines.

It also **fails open**. An unexpected failure inside detection serves the request; the error
goes to your `onError` and the visitor gets their page. A bot filter that fails closed is an
outage with extra steps.

## Now the important part

### The client IP

Stop here if Serif sits behind anything — a load balancer, a CDN, nginx, a service mesh.

The client address becomes the [actor key](07-actors.md). Every rate limit, every allowlist
entry, every behavioural signal depends on it.

`X-Forwarded-For` is a **client-supplied header**. Trust it without knowing how many proxies
sit in front of you and anyone can prepend a fake hop and choose the address you rate-limit,
allowlist and block on. **The failure is silent** — nothing errors, nothing logs, and every
per-actor mechanism becomes an attacker input.

There is deliberately no convenient default.

```js
proxy: { trustProxy: true, trustedProxies: ["10.0.0.0/8"] }   // recommended
proxy: { trustProxy: true, hops: 2 }                          // correct only while the count is
proxy: { trustProxy: false }                                  // default — header ignored entirely
```

**Use `trustedProxies`.** The chain is walked from the right, discarding your own
infrastructure, and the first address outside it is the client — robust against an extra hop
appearing when somebody adds a CDN and forgets to tell you.

`hops` is right until the topology changes, and then it is wrong in the direction that lets
clients choose their own address.

Three details worth knowing:

**Addresses are compared as bytes.** `::ffff:127.0.0.1`, `0177.0.0.1` and `127.0.0.001` are
the same address, and all slip past an allowlist that compares strings. Invalid CIDRs throw
at construction rather than matching nothing silently.

**The connecting peer is checked too.** On a server reachable both through the load balancer
and directly, a request arriving from outside your trusted ranges did not come through your
proxies — so its forwarded header is not evidence, and the socket address is used. Without
that check, anyone who finds the origin address picks their own client IP.

**Do not allowlist loopback.** The moment you sit behind nginx or beside a sidecar, every
request in the world arrives from `127.0.0.1`.

### On Fetch runtimes

There is no socket, so the address comes from a header. Only `cf-connecting-ip` and
`x-real-ip` are trusted by default — both single-valued, written by the edge that terminated
the connection. `x-forwarded-for` is **not**, because a proxy *appends* to it.

Better still, ask the platform:

```js
withBotHandler(detector, myHandler, {
  clientIp: (request, env) => env.cf?.connectingIp,
});
```

If no address can be found, every visitor is tracked under one empty actor key — which
applies your rate limits to the whole site at once. The adapter warns the first time.

On Workers, enable `nodejs_compat`; the engine uses `node:crypto`.

## Tell it about your own people

The only conclusive human signal in this library is your assertion:

```js
new BotHandler({
  isHuman: (facts) => Boolean(sessions.get(facts.session ?? "")?.authenticated),
});
```

That produces `certain` human evidence, which is what the `cleared-human-allow` rule at the
top of most presets is for. Without it that rule never fires, and your signed-in customers
are judged like strangers.

## Serif, mounted

```js
import express from "express";
import { BotHandler } from "@osqd/bothandlerjs";
import { botHandler } from "@osqd/bothandlerjs/adapters";

const site = new BotHandler({
  preset: "monitor-only",                     // week one. Enforce later.
  proxy: { trustProxy: true, trustedProxies: ["10.0.0.0/8"] },
  allowlist: ["10.0.0.0/8"],                  // monitors and CI
  ignorePaths: ["/healthz", "/metrics"],
  isHuman: (facts) => Boolean(sessions.get(facts.session ?? "")?.authenticated),
  challenge: { secrets: [process.env.SERIF_CHALLENGE_SECRET], contactHtml: "<p>…</p>" },
  onWarning: (message) => console.warn("[bot]", message),
  onDowngrade: ({ decision }) => console.warn(`[bot] guard stopped rule ${decision.rule}`),
});

const auth = new BotHandler({ preset: "protect-auth", proxy: { trustProxy: true, trustedProxies: ["10.0.0.0/8"] } });

const app = express();
app.use(botHandler(site));
app.use("/login", botHandler(auth));
app.use("/checkout", botHandler(auth));
```

Note `allowlist` and `ignorePaths` are different things. An **ignored path** is not
assessed. An **allowlisted address** is not judged *at all* — not judged leniently, not
judged. It is the strongest setting in the library, and the one most worth alerting on when
it changes.

## Exercise

Serif runs on Cloudflare in front of a Node origin. A colleague suggests
`proxy: { trustProxy: true, hops: 1 }`. What is wrong with it, and what breaks?

<details>
<summary>Answer</summary>

`hops: 1` takes the **last** entry in `X-Forwarded-For`, which is what Cloudflare appended —
so today it is right. It breaks the moment anything is added in front: another CDN, a
regional load balancer, a WAF. Then the last entry is that hop's, and Cloudflare's entry —
the real client — is one further left.

Worse, the failure is silent and the wrong direction: the address you rate-limit becomes one
your own infrastructure controls, so all traffic collapses onto one actor.

```js
proxy: { trustProxy: true, trustedProxies: [...cloudflareRanges, "10.0.0.0/8"] }
```

Walking from the right and discarding known infrastructure survives an extra hop appearing.
And on the Cloudflare edge itself, prefer `clientIp: (req, env) => env.cf?.connectingIp` —
ask the platform, not a header.
</details>

## What you learned

- Four adapters, plus Hono and Next.js for free; the engine never touches a response
- It fails open, on purpose
- `trustedProxies` over `hops`, always; the failure mode of getting it wrong is silent
- `isHuman` is the only conclusive human signal that exists
- Allowlisting stops detection entirely — it is not leniency

## Reference

- [Adapters](../integration/adapters.md) · [The client IP](../integration/client-ip.md)
- [Configuration](../reference/configuration.md)

Next: [Operating it](13-operating-it.md).
