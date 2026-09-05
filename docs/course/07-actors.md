# Lesson 7 — Actors and behaviour over time

**Goal:** watch suspicion accumulate across requests, and understand why the identity you
choose decides how good every behavioural signal is.

← [Course](index.md) · Prev: [Identity and verification](06-identity.md) · Next: [Traps](08-traps.md)

---

## One request tells you less than six

Everything so far judged a single request. Four detectors need more than that:
`rate-anomaly`, `cadence`, `crawl-breadth` and `session-integrity` all read an **actor** —
the library's word for "the same client, seen again".

## Do this

Forty requests from one address, exactly 250 ms apart — a metronome:

```js
import { BotHandler, createFacts } from "@osqd/bothandlerjs";

const detector = new BotHandler();
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

for (let i = 0; i < 40; i++) {
  const a = await detector.assess(
    createFacts({
      method: "GET",
      url: `/books/${i}`,
      ip: "203.0.113.91",
      headers: { host: "serif.example", "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-GB,en;q=0.9", "accept-encoding": "gzip, deflate, br" },
      timestamp: 1_700_000_000_000 + i * 250,
    }),
  );

  if ([9, 19, 39].includes(i)) {
    console.log(`after ${i + 1}: score=${a.score} verdict=${a.verdict} requests=${a.actor.requests} paths=${a.actor.distinctPaths}`);
    for (const e of a.evidence) console.log(`    [${e.certainty}] ${e.detector}: ${e.summary}`);
  }
}
```

Passing an explicit `timestamp` is what makes this reproducible — you are simulating time
rather than waiting for it.

### Checkpoint

```
after 10: score=45 verdict=unknown requests=10 paths=10
    [moderate] cadence: Arrivals are machine-regular: 9 gaps averaging 250ms with a coefficient of variation of 0.000

after 20: score=69 verdict=suspected-bot requests=20 paths=20
    [moderate] cadence: Arrivals are machine-regular: 19 gaps averaging 250ms with a coefficient of variation of 0.000
    [moderate] session-integrity: 20 requests from this actor, none carrying any cookie
    [weak] rate-anomaly: 20 requests in 10s (2/s) from this actor

after 40: score=80 verdict=suspected-bot requests=40 paths=40
    [moderate] cadence: Arrivals are machine-regular: 31 gaps averaging 250ms with a coefficient of variation of 0.000
    [moderate] rate-anomaly: 32 requests in 10s (3.2/s) from this actor
    [moderate] session-integrity: 40 requests from this actor, none carrying any cookie
    [weak] crawl-breadth: 40 distinct paths across 40 requests (100% never revisited)
```

**The headers never changed.** Every request looked like a perfectly ordinary browser on
its own; the case was built entirely out of the relationship between them.

Note `cadence` — a coefficient of variation of exactly 0.000. That is the signal that
catches the *polite* scraper: one pacing itself deliberately under your rate limit is
invisible to rate counting and obvious here, because people are irregular and loops are
not.

## The saturation you can see

At 40 requests, `cadence` reports "31 gaps" and `rate-anomaly` "32 requests". Not a bug —
the arrival ring holds **32 timestamps**, deliberately.

Per-actor state is a fixed budget: 32 arrival timestamps, 64 path *hashes* (not strings),
up to 4 User-Agents, and at most 20,000 actors in a bounded LRU. Every structure keyed by
something a client controls has a ceiling, because an unbounded map keyed by IP is a remote
OOM.

The trade-off is stated rather than hidden: `requestsWithin` saturates at 32 and reports
`undercounted: true` rather than a true rate. That series exists to *describe* an actor
cheaply; exact counting belongs to the `rate-limit` action, which uses a store.

## The actor key is the most valuable thing you can change

By default an actor is the client address. An address is a poor identity: shared by a whole
office, changed by a phone every few minutes, and behind CGNAT it is thousands of people.

**Every behavioural detector is only as good as this function.**

```js
new BotHandler({
  actorKey: (facts) => facts.session ?? facts.ip,
});
```

A session id, an authenticated user id, or an address plus a TLS fingerprint all make the
same detectors sharper — sharp enough that `identity-rotation` becomes worth enabling,
which under an IP key would fire on every corporate NAT.

This is also why the behavioural signals are *capped* where they are. Under an address key
"one actor" may be a university, so nothing here may exceed `moderate` and none of it can
deny anybody on its own. The [guard](04-the-guard.md) guarantees that structurally.

## What an actor remembers

```js
console.log(a.actor);
```

| Field | |
| ----- | - |
| `key` | what it is tracked under |
| `requests`, `distinctPaths` | inside the behavioural window |
| `firstSeen`, `lastSeen`, `sinceLastMs` | |
| `priorConfirmations` | assessments in the window that concluded `confirmed-bot` |
| `unsolvedChallenges` | outstanding, not cumulative — solving one clears it |

`unsolvedChallenges` is deliberately **not evidence**. One abandoned challenge is a person;
what repeated abandonment means is a judgement about your traffic that only you can make,
so it is exposed as something a *rule* can read. You will use it in
[lesson 11](11-the-challenge.md).

Idle actors are forgotten after `actorWindowMs` (default 15 minutes), and past `maxActors`
the least recently seen is evicted — never one still sending traffic.

## Forgetting one, by hand

The support-ticket path. Somebody is being challenged, you have looked at their requests,
and you are satisfied:

```js
detector.forgetActor("203.0.113.91", { by: "you@serif.example" });
detector.clearActor("203.0.113.91", 60 * 60_000, { by: "you@serif.example" });
```

`clearActor` exempts them for a stated number of milliseconds, so the exemption expires on
its own rather than becoming a permanent hole nobody remembers opening.

## Exercise

Re-run the forty requests with a *human* rhythm — random gaps between 400 ms and 6 s — and
have each request revisit one of five paths rather than a new one each time.

<details>
<summary>What you should see, and what it means</summary>

`cadence` stops firing, because the coefficient of variation is no longer near zero.
`crawl-breadth` stops firing, because 5 distinct paths across 40 requests is reading rather
than enumerating. `session-integrity` still fires — no cookie is still no cookie — and the
score settles far below the threshold.

That is the honest limit of behavioural detection, and it is the top of the evasion ladder
in the [threat model](../concepts/threat-model.md): a scraper paced like a person, taking a
few pages per address, is **not caught at all**. What defeats that is cost — a challenge,
or an account — not detection.

Knowing precisely where your detection stops is more useful than believing it does not.
</details>

## What you learned

- Four detectors read an actor rather than a request, and build a case across time
- `cadence` catches the polite scraper that rate counting cannot
- Per-actor state is a fixed, bounded budget, and it saturates visibly rather than lying
- `actorKey` is the highest-value thing you can replace
- Behavioural signals are capped at `moderate` because an address is a poor identity

## Reference

- [Actors and behavioural memory](../concepts/actors.md)
- [The detectors](../detection/detectors.md) — the behavioural four in detail
- [Threat model](../concepts/threat-model.md) — where this stops working

Next: [Traps](08-traps.md) — the one detector that needs no statistics at all.
