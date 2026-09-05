# Actors and behavioural memory

Who "the same client" is, what is remembered about them, and for how long.

← [Documentation](../index.md)

---

Several detectors reason about behaviour over time — rate, rhythm, breadth, rotation —
and all of them need an answer to one question first: *are these two requests the same
client?*

## The actor key

```ts
actorKey: (facts) => facts.ip          // the default
```

Every behavioural signal in this library is only as good as this function. The default is
the client address, which is the only thing always available and is also the weakest: a
corporate NAT, a mobile carrier's CGNAT pool, a university and a VPN exit all present
hundreds of real people as one actor.

If you can do better, do:

```ts
actorKey: (facts) => sessionIdFrom(facts) ?? facts.ip,
```

A session id, an authenticated user id, or an address plus a TLS fingerprint all make the
same detectors sharper — sharp enough that
[`identity-rotation`](../detection/detectors.md#identity-rotation) becomes worth enabling,
which it is not on a shared address.

## What is remembered

```ts
const snapshot = assessment.actor;
```

| Field | |
| ----- | --- |
| `key` | Whatever `actorKey` returned |
| `requests` | Requests in the window |
| `distinctPaths` | Breadth of the crawl |
| `firstSeen` / `lastSeen` | Epoch ms |
| `sinceLastMs` | Gap since the previous request |
| `priorConfirmations` | Times this actor was **proven** a bot before now |
| `unsolvedChallenges` | Challenges issued that no solution came back for |
| `cleared` | Holds a currently-valid human clearance |

`priorConfirmations` is a snapshot taken *before* this request's own outcome is recorded,
so a rule reading `minPriorConfirmations: 1` does not match on an actor's very first
request.

## Everything here is bounded

Every key in this subsystem is attacker-chosen, so nothing may grow without limit:

- An actor's arrival history is a **fixed-size ring** of timestamps.
- Its path set is **capped**, and the cap is visible (`pathsSaturated`) so a detector can
  tell "wide" from "we stopped counting".
- The registry itself is a **bounded LRU** with a TTL: `maxActors` (default 20,000) and
  `actorWindowMs` (default 15 minutes).

```ts
actorWindowMs: 900_000,
maxActors: 20_000,
```

An actor still sending traffic is never the one evicted to make room, and eviction is
plain forgetting: the next request from that client is assessed as a first request.

## It is process-local, deliberately

Rates, cadence and path breadth live in memory rather than in a shared store. A round trip
per request would buy accuracy for signals that are only ever allowed to *raise suspicion*
— never to deny anybody — and would put a network dependency on the hot path of every
request to your site.

Behind four replicas each one sees a quarter of an actor's traffic and is correspondingly
less sure. That is the right trade for something that cannot close a door on its own.

**A confirmation is not one of those**, and it can travel:

```ts
new BotHandler({ store: new RedisStore(redis), shareConfirmations: true });
```

`confirmed-bot` is a *proven* verdict — a fact about the client rather than a judgement
about it — and without sharing it a client proven to be a bot on one replica is a stranger
to the other seven. Proof travels; suspicion stays home. See
[Shared state](../integration/stores.md).

## Acting on one actor by hand

```ts
detector.forgetActor("203.0.113.9");            // discard its history
detector.clearActor("203.0.113.9", 3_600_000);  // grant human clearance for an hour
detector.registry.top(50, Date.now());          // who is here, busiest first
```

`forgetActor` is the cure for a false positive that has stuck: a person whose actor key
collected a `confirmed-bot` carries `priorConfirmations` for the rest of the window, and
before this existed the only remedy was clearing every actor's history to fix one.

These are also on the [dashboard](../operations/dashboard.md), behind a control flag.

## Related

- [The detectors](../detection/detectors.md) — which ones read this state
- [Shared state](../integration/stores.md) — what crosses replicas
- [Getting the client address right](../integration/client-ip.md) — the input to all of it
