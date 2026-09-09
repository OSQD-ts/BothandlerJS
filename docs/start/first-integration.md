# Your first integration

Working in five minutes, safe in one week.

← [Documentation](../index.md) · [Getting started](../index.md)

---

## The five minutes

```ts
import { BotHandler } from "@osqd/bothandlerjs";
import { botHandler } from "@osqd/bothandlerjs/adapters";

const detector = new BotHandler({
  preset: "monitor-only",               // watch first; enforce later
  allowlist: ["10.0.0.0/8"],            // your monitors and CI
  ignorePaths: ["/healthz", "/metrics"],
});

app.use(botHandler(detector));

await detector.serveDashboard({ port: 9674 });
```

Open **http://localhost:9674/**. Every request lands in the feed with its verdict, and any
row opens to show the [evidence](../concepts/evidence.md) behind it.

Nothing is being withheld from anybody — [`monitor-only`](../policy/presets.md#monitor-only)
never acts. That is deliberate, and it is step one of four.

## The four steps

### 1. Watch, for a week

Run `monitor-only` on real traffic and look at the dashboard. You are looking for the
integration you forgot about: the partner's nightly sync, the status-page prober, the
marketing team's link checker, your own server-side renderer.

Every bot policy that has caused an outage was deployed straight to enforcement by someone
who was sure they knew what their traffic looked like.

### 2. Fix the client address

If anything sits in front of your process — a load balancer, a CDN, nginx, a service mesh —
this is the setting that matters most:

```ts
proxy: { trustProxy: true, trustedProxies: ["10.0.0.0/8"] }
```

The client address becomes the [actor key](../concepts/actors.md), which every rate limit,
allowlist entry and behavioural signal depends on. Getting it wrong is silent. Read
[the client IP](../integration/client-ip.md) — it is short and it is the page most worth
reading twice.

### 3. Check the policy you are about to enable

```bash
npx @osqd/bothandlerjs check --preset protect-content
npx @osqd/bothandlerjs replay /var/log/nginx/access.log --preset protect-content
```

The first runs your policy against [548 shapes of real traffic](../testing/corpus.md); the
second runs it against yours. Read the list of would-be-denied requests. If any of them is a
person, the policy is wrong — and you found out from a log file.

Put the `check` in CI. It exits non-zero when a case marked as a person is denied.

### 4. Enable it

```ts
const detector = new BotHandler({
  preset: "protect-content",
  proxy: { trustProxy: true, trustedProxies: ["10.0.0.0/8"] },
  challenge: {
    secrets: [process.env.BOT_CHALLENGE_SECRET!],
    contactHtml: '<p>Locked out? Email <a href="mailto:support@example.com">support@example.com</a>.</p>',
  },
  allowlist: ["10.0.0.0/8"],
  ignorePaths: ["/healthz", "/metrics"],
  onDowngrade: ({ decision }) => log.warn(`rule ${decision.rule} asked for more than its evidence`),
});
```

Then watch `bothandler_downgrades_total` — see [metrics](../operations/metrics.md).

## What a working configuration does

| Request | Result |
| ------- | ------ |
| A real Chrome navigation | `200` — served, untouched |
| `curl https://yoursite/` | challenge page — proven `http-client` |
| A `Googlebot` UA from an address DNS refutes | `403` — proven `impersonator` |
| `sqlmap` | `403` — self-identified scanner |
| A hit on a [trap](../detection/detectors.md) link | `403` — no person can reach it |
| `GET /healthz` | `200` — never assessed |
| Real Googlebot, confirmed by DNS | `200` — explicitly allowed |

## Three things people wish they had done sooner

**Replace `actorKey`.** An address is a poor identity — shared by an office, changed by a
phone every few minutes. A session id makes every behavioural detector sharper:

```ts
actorKey: (facts) => facts.session ?? facts.ip
```

**Add `isHuman`.** Your authenticated session is the only conclusive human signal that
exists. Telling the library about it stops it second-guessing your own customers:

```ts
isHuman: (facts) => Boolean(sessions.get(facts.session ?? "")?.authenticated)
```

**Mount [`protect-auth`](../policy/presets.md#protect-auth) separately** on login, signup and
checkout — and *only* there. Site-wide it refuses your webhooks and your renderer.

```ts
app.use("/login", botHandler(authDetector));
```

## Next

- [Choosing a policy](choosing-a-policy.md)
- [Adapters](../integration/adapters.md) — Fastify, Koa, Hono, Next.js, Workers
- [The dashboard](../operations/dashboard.md) — before you expose it anywhere real
