# Lesson 14 — Scaling, and changing it live

**Goal:** run Serif on more than one process without breaking your rate limits, and change
a rule during an incident without a deploy.

← [Course](index.md) · Prev: [Operating it](13-operating-it.md) · Next: [Extending it](15-extending.md)

---

## What breaks at two replicas

Two things, and both are correctness rather than optimisation.

**Single-use challenge nonces.** Without sharing, a scraper retries a solved nonce against
another replica until one has not seen it.

**Rate limits.** A limit of 100/minute enforced independently by four replicas is a limit of
400/minute.

```js
import { RedisStore } from "@osqd/bothandlerjs";
new BotHandler({ store: new RedisStore(redis) });
```

`RedisStore` takes a client you already have. The package stays dependency-free — it uses
the handful of methods `ioredis` and `node-redis` share, and imports neither.

## What deliberately does not scale, and why

Behavioural state — arrival rates, cadence, path breadth, User-Agent history — stays in
memory per process, on purpose.

A round trip per request would buy accuracy for signals that are only ever allowed to
**raise suspicion**, never to deny anybody: the [guard](04-the-guard.md) sees to that.
Behind four replicas each sees a quarter of an actor's traffic and is correspondingly less
sure, which is the right trade for something that cannot close a door on its own.

Spending a network round trip on the request path to sharpen a signal that cannot act alone
is a bad bargain, and the request path is where this library refuses to make bad bargains.

## Except proof, which travels

A `confirmed-bot` verdict is *proven* — something declared itself, forged an identity, or
walked into a trap. That is a fact about the client rather than a judgement about it:

```js
new BotHandler({ store: new RedisStore(redis), shareConfirmations: true });
```

Without it, a client proven to be a bot on one replica is a stranger to the other seven, and
a rule reading `minPriorConfirmations: 1` fires about an eighth as often as it reads.

**Proof travels; suspicion stays home.** That sentence is the whole design.

The cost is one store read the **first time each instance sees an actor** — not one per
request — and it is never awaited, so nothing joins the request path. A store outage means
the count falls back to what that process saw itself.

## Changing things without a deploy

Two things go stale between deploys, and both hurt.

**Published crawler ranges.** A stale list turns a verified crawler into an accused
impersonator.

**A rule set.** Sometimes a rule is wrong in a way you want to fix *now* — which is exactly
when the deploy pipeline feels longest.

### Rules

```js
detector.updatePolicy(
  [...detector.policy.rules, { id: "allow-healthz", match: { path: "/healthz" }, action: "allow" }],
  { by: "you@serif.example" },
);
```

Validated first, swapped **atomically**, announced through `onWarning` and `policy-change`.
Invalid input throws and leaves the previous set standing.

**What it cannot change:** `falsePositivePolicy`, `fallbackAction` and
`terminalScoreThreshold`. No runtime edit can relax the guard through this door.

### The guard

Its own method, its own event, its own dashboard flag:

```js
detector.updateGuard({ falsePositivePolicy: "balanced" }, { by: "you@serif.example" });
// warning: Guard settings changed at runtime by you@serif.example:
//          falsePositivePolicy strict → balanced.
```

`onGuardChange` carries the before and the after. **If you page on one thing in this
lesson, page on this.**

### Ranges and actors

```js
detector.updateCrawlerRanges("gptbot", await fetchRanges());
detector.updateRanges("allowlist", [...current, "198.51.100.0/24"]);
detector.listRanges();                      // [{ name: "crawler:gptbot", size: 42 }, …]

detector.forgetActor(key, { by: "you@serif.example" });
detector.clearActor(key, 60 * 60_000, { by: "you@serif.example" });
```

`range-change` is worth alerting on: the allowlist is the one list that stops detection
*running*.

### `by`, and the audit trail

Every mutating method takes `{ by }`. The dashboard fills it from its own `auth` — a basic
credential names itself, and a custom `authorize` can return an identity instead of `true`.

The library has no user model and does not want one. It carries the name it was given into
the warning and the event, so your trail can say *who* rather than only *what*:

```js
detector.on("policy-change", ({ by, rules }) => auditLog.write({ who: by, count: rules.length }));
```

Nothing verifies the name. It is exactly as trustworthy as whatever supplied it — which is
your authentication, the same thing that decides whether the change is allowed at all.

## The incident runbook

Put this somewhere you can find it at 3am.

```js
// 1. See it.            dashboard → live feed, filter to denials
// 2. Slow it, uniformly.
detector.updatePolicy([
  { id: "incident-ceiling", match: {}, action: "rate-limit",
    params: { limit: { max: 30, windowMs: 60_000 } } },
  ...detector.policy.rules,
], { by: "you@serif.example" });

// 3. Only if that is not enough — and read the preset's warning first.
//    It refuses proven automation, so allowlist your webhooks BEFORE switching over.
```

A uniform ceiling is the one mitigation that cannot be wrong about who somebody is. Reach
for it before you reach for anything that singles clients out.

And note what is *not* in the runbook: `falsePositivePolicy: "aggressive"`. An incident is
precisely when people reach for it, and precisely when the population getting caught is at
its most unusual.

## Exercise

Serif runs eight pods behind a load balancer. A rule reads
`{ minPriorConfirmations: 1, action: "block" }`. It fires far less than expected. Why, and
what are the two fixes?

<details>
<summary>Answer</summary>

Each pod only knows about the confirmations *it* saw. A client proven on pod 3 is a stranger
to the other seven, so with traffic spread evenly the rule fires roughly one time in eight.

**Fix one — share the proof:**

```js
new BotHandler({ store: new RedisStore(redis), shareConfirmations: true });
```

This is what that flag is for. Proof is a fact about the client, so it can cross replicas;
suspicion stays home.

**Fix two — give the actors a better key.** If the load balancer has session affinity, or if
you key on a session id rather than an address, the same client lands where its history is:

```js
actorKey: (facts) => facts.session ?? facts.ip
```

Both are worth doing, and the second helps every behavioural detector as well — see
[lesson 7](07-actors.md).
</details>

## What you learned

- Nonces and rate limits need a shared store; that is correctness, not tuning
- Behavioural state stays process-local because it can never deny anybody alone
- `shareConfirmations` lets *proof* cross replicas, unawaited and once per actor
- `updatePolicy` cannot relax the guard; `updateGuard` is a separate, alertable power
- A uniform ceiling is the safest first move in an incident

## Reference

- [Stores](../integration/stores.md) · [Runtime changes](../operations/runtime-changes.md)
- [Presets](../policy/presets.md#under-attack)

Next: [Extending it](15-extending.md).
