# Stores

What has to be shared across replicas, what deliberately is not, and why.

← [Documentation](../index.md) · [Integration](index.md)

---

## The default

An in-memory store. Correct for a single process, and honest about what it is not.

```ts
import { RedisStore } from "bothandlerjs";
new BotHandler({ store: new RedisStore(redis) });   // ioredis or node-redis; no dependency added
```

`RedisStore` takes a client you already have. The package stays dependency-free — it uses
the handful of methods both major clients share.

## What needs a shared store

**Single-use challenge nonces.** Without sharing, a scraper retries a solved nonce against
another replica until one has not seen it. See [the challenge](../challenge/index.md).

**Rate limits.** A limit of 100/minute enforced independently by four replicas is a limit of
400/minute. See [`rate-limit`](../policy/actions.md#rate-limit).

Those two are correctness, not optimisation. If you run more than one process and use either
feature, you need a store.

## What deliberately stays process-local

**Behavioural state** — arrival rates, cadence, path breadth, User-Agent history — lives in
memory, on purpose.

A round trip per request would buy accuracy for signals that are only ever allowed to *raise
suspicion*, never to deny anybody: the [guard](../concepts/the-guard.md) sees to that.
Behind four replicas each one sees a quarter of an actor's traffic and is correspondingly
less sure, which is the right trade for something that cannot close a door on its own.

Spending a network round trip on the request path to sharpen a signal that cannot act alone
is a bad bargain, and the request path is the one place this library refuses to make bad
bargains.

## Confirmations are not one of those

A `confirmed-bot` verdict is *proven* — something declared itself, forged an identity, or
walked into a trap. That is a fact about the client rather than a judgement about it, so it
can travel:

```ts
new BotHandler({ store: new RedisStore(redis), shareConfirmations: true });
```

Without it, a client proven to be a bot on one replica is a stranger to the other seven, and
`minPriorConfirmations: 1` fires about an eighth as often as it reads.

**Proof travels; suspicion stays home.** That single sentence is the whole design.

The cost is one store read the **first time each instance sees an actor** — not one per
request — and it is never awaited, so nothing joins the request path. A store outage means
the count falls back to what that process saw itself.

## Writing your own

Implement `BotHandlerStore`. The interface is small — get, set, increment, an atomic
claim — and every method may fail: the engine treats a store error as "no answer" and
carries on serving, because a store outage must not become a site outage.

## Related

- [The challenge](../challenge/index.md) — replay protection
- [Actions](../policy/actions.md#rate-limit) — the one action that needs this
- [Actors](../concepts/actors.md) — what the local state actually holds
- [The guard](../concepts/the-guard.md) — why local behavioural state is safe
