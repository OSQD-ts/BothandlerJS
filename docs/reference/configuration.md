# Configuration reference

Every option `BotHandler` takes, grouped by what it is for.

← [Documentation](../index.md)

---

```ts
new BotHandler({
  // Detection
  detectors, extraDetectors, signatures, extraSignatures,
  suspectThreshold: 60, strictEvidence, detectorTimeoutMs: 300,

  // Policy
  preset, rules, defaultAction: "allow", defaultActionParams,
  falsePositivePolicy: "strict", fallbackAction, terminalScoreThreshold: 85,

  // Addresses — invalid CIDRs throw at construction, never match silently
  allowlist, denylist, datacenterRanges, crawlerRanges: { gptbot: ["1.2.3.0/24"] },

  // Identity and scope
  proxy: { trustProxy, trustedProxies, hops, header },
  actorKey: (facts) => facts.ip,
  ignorePaths, isHuman,

  // Observation
  audit: { windowMs: 300_000, baselineMs: 3_600_000, minSamples: 50 },
  onAssessment, onDecision, onDenial, onDowngrade, onChallenge,
  onDetectorFailure, onPolicyChange, onGuardChange, onRangeChange, onActorChange, onAnomaly,

  // Infrastructure
  challenge, store, notifications, handlers, resolver, clock,
  shareConfirmations: false,              // proof crosses replicas; suspicion does not
  actorWindowMs: 900_000, maxActors: 20_000, exposeVerdictHeaders: false,
  metrics: true,                          // or { perDetectorTiming: true }
  onError, onWarning,
});
```

---

## Detection

| Option | Default | |
| ------ | ------- | - |
| `detectors` | the default set | replaces it **entirely** |
| `extraDetectors` | — | appended; ignored when `detectors` is given |
| `signatures` | `BOT_SIGNATURES` | replaces the [signature database](../detection/signatures.md) |
| `extraSignatures` | — | appended to it |
| `suspectThreshold` | `60` | score at or above which an unproven request is `suspected-bot` |
| `strictEvidence` | `true` outside production | reject `certain` evidence carrying no `deterministicBasis` |
| `detectorTimeoutMs` | `300` | budget per `io` detector; exceeding it drops the detector, not the request |

`strictEvidence` downgrades to a warning when `NODE_ENV` is `production`, so a third-party
detector with a missing basis cannot take a live site down. See
[evidence](../concepts/evidence.md).

## Policy

| Option | Default | |
| ------ | ------- | - |
| `preset` | — | a named [starting policy](../policy/presets.md) |
| `rules` | — | your own [rules](../policy/rules.md), evaluated **before** any preset's |
| `defaultAction` | `"allow"` | when nothing matches |
| `defaultActionParams` | — | params for it |
| `falsePositivePolicy` | `"strict"` | [the guard's](../concepts/the-guard.md) mode |
| `fallbackAction` | `"challenge"` | substituted when the guard stops a terminal action; **cannot itself be terminal** |
| `terminalScoreThreshold` | `85` | score needed for a terminal action under `balanced` |

## Addresses

| Option | |
| ------ | - |
| `allowlist` | exempt from detection **entirely** — your monitors, your office, your CI |
| `denylist` | treated as proven automation; an explicit local decision |
| `datacenterRanges` | hosting-provider ranges; none ships with the library |
| `crawlerRanges` | published ranges keyed by signature id — see [verification](../detection/verification.md) |

Invalid CIDRs **throw at construction**. A range that silently matches nothing is a control
you believe you have and do not.

`allowlist` is the strongest thing here: an address on it is not judged leniently, it is not
judged at all. Do not put loopback on it — see [the client IP](../integration/client-ip.md).

## Identity and scope

| Option | Default | |
| ------ | ------- | - |
| `proxy` | `{ trustProxy: false }` | **read [the client IP](../integration/client-ip.md) first** |
| `actorKey` | the client address | the single most valuable thing to replace |
| `ignorePaths` | — | health checks, your own polling endpoints, static assets |
| `isHuman` | — | your application declaring a request human |

`ignorePaths` matches three ways, and the difference between the first two is a single
trailing slash:

| Entry | Matches |
| --- | --- |
| `"/healthz"` | that path exactly, and nothing else — not `/healthz/live`, not `/healthz?x=1` |
| `"/assets/"` | any path starting with `/assets/`, so the whole subtree |
| `/^\/static\/.*\.js$/` | whatever the expression tests true against |

So `ignorePaths: ["/assets"]` ignores exactly one path called `/assets` and nothing beneath
it, which is almost never what was meant. Write `"/assets/"` for the subtree.

An ignored request is not assessed, **and it does not appear in the dashboard's live
feed** — there is no verdict for a row to show. It is still counted, so the Statistics
screen can tell you how much of your traffic detection actually ran on. If you want to see
these requests go past, they do not belong in `ignorePaths`.

### Service tokens

A challenge is unanswerable from `fetch`. An uptime monitor is a bare HTTP client with no
browser and nothing browser-shaped about it, so a strict policy challenges it — and then
it reports the site down every fifteen minutes while the site is fine.

The fix is a rule that lets it through, and written by hand that rule handles a credential
with no help at all. It almost always compares the secret with `===`, which is
variable-time, and carries it in a header this library has never heard of, which is
therefore printed in full on the dashboard and into every export.

```ts
new BotHandler({
  serviceTokens: { tokens: { "uptime monitor": process.env.MONITOR_SECRET! } },
  rules: [{ id: "monitor-allow", match: { serviceToken: "uptime monitor" }, action: "allow" }],
});
```

| | |
| --- | --- |
| `header` | Where the token arrives. Default `x-bothandler-token`. |
| `tokens` | Name → secret. The name is matched and displayed; the secret is neither. |

What this buys over the rule you would have written:

- **Constant-time comparison.** Both values are hashed and the digests compared, so a
  length mismatch is not an oracle for the length of the real secret either.
- **Redacted by construction.** Configuring a token tells the library that header holds a
  credential, so it is `[redacted]` wherever headers are shown and stripped from any event
  leaving through a notification sink — without also listing it under `secretHeaders`.
- **Only the name travels.** `match: { serviceToken: "uptime monitor" }` compares a name.
  `serviceToken: true` matches any configured token.
- **It is checked at boot.** A rule naming a token that does not exist, a token whose
  value is empty (an unset environment variable), and a secret short enough to guess each
  produce a warning rather than a rule that silently never fires.

Presenting a valid token **changes no verdict**. It is recorded, and only a rule decides
what it is worth — the same guarantee labels have, and for the same reason.

**Know what it is.** A shared secret in a header is the weakest credential there is: it
does not expire, anyone who sees it once can replay it, and it says nothing about *which*
caller sent it. It is right for a monitor you operate calling an endpoint you operate, and
wrong for anything a third party holds.

`isHuman` produces `certain` human evidence — the only conclusive human signal available,
because it comes from you and not from the client. An authenticated session, a completed
payment, whatever bar you set:

```ts
isHuman: (facts) => Boolean(facts.session && sessions.get(facts.session)?.authenticated)
```

## Observation

`audit` takes [`AuditOptions`](../operations/audit.md) or `false`. Every `onX` hook mirrors
an [event](../operations/index.md#events-and-hooks) — the config form is convenient, the
emitter form can be subscribed to later and removed.

## Infrastructure

| Option | Default | |
| ------ | ------- | - |
| `challenge` | — | enables the [challenge action](../challenge/index.md); without it those rules degrade to `tag` |
| `store` | in-memory | see [stores](../integration/stores.md) |
| `shareConfirmations` | `false` | proof crosses replicas; suspicion does not. Needs a shared store |
| `notifications` | — | [sinks, filtering, redaction](../operations/notifications.md) |
| `handlers` | — | [`custom` action](../policy/actions.md#custom) handlers |
| `resolver`, `clock` | system | injected for tests and the [corpus](../testing/corpus.md) |
| `actorWindowMs` | `900_000` | how long an idle [actor](../concepts/actors.md) is remembered |
| `maxActors` | `20_000` | a memory budget; past it the least recently seen actor is evicted |
| `exposeVerdictHeaders` | `false` | **leave it off** — see below |
| `metrics` | `true` | or `{ perDetectorTiming: true }` |
| `onError`, `onWarning` | — | |

### `exposeVerdictHeaders`

An `X-Bot-Score` in the *response* is a live feedback signal for anyone tuning a scraper
against you: change one header, watch the number fall, iterate. Request-side tagging gives
your application the same information and tells the client nothing. It is off by default and
should stay off.

---

## Performance and memory

Detection on a clean browser request costs about **9 µs** to assess and **12 µs** end to
end, and allocates a few hundred bytes. `npm run bench` reports the median of several
rounds; `npm run bench:guard` enforces a ratio-based budget so a regression fails the build
rather than shipping quietly.

Five things got it there, each a trap the next person will meet too:

- `header-order` computed an HMAC fingerprint on every request before knowing whether it had
  anything to report — it cost more than the other twelve detectors combined.
- `randomBytes` was called per request for the request id; it is now drawn from a pooled
  buffer.
- The User-Agent tokeniser ran eagerly, when a mainstream browser string never needs it.
- The notification event — an ISO timestamp included — was built before checking whether any
  sink was listening.
- Per-detector timing allocated a closure per detector per request *whether or not it was
  switched on*: 8 µs a request to support a feature that is off by default. The benchmark
  caught that one, which is what a benchmark is for.

Signatures compile once into an Aho–Corasick automaton with a flat transition table for the
root node, so matching is O(input length) regardless of how many signatures exist, and text
that matches nothing allocates nothing at all.

DNS runs only when a request actually claimed a verifiable identity, and results are cached:
successes for an hour, transient failures for a minute, definitive absences for an hour.

Per-actor state is a fixed budget: 32 arrival timestamps, 64 path *hashes* (not strings), up
to 4 User-Agents. At 20,000 tracked actors that is tens of megabytes, not hundreds. Every
structure keyed by anything a client controls is a bounded LRU — an unbounded map here would
be a remote OOM.

The trade-off: `requestsWithin` saturates at 32, so a very heavy actor is reported as "at
least 32" with `undercounted: true` rather than at its true rate. Deliberate — that series
exists to describe an actor cheaply, and exact counting belongs to the
[`rate-limit`](../policy/actions.md#rate-limit) action, which uses the store.

## Related

- [API](api.md) — the methods and the exported names
- [The guard](../concepts/the-guard.md) — the four options that decide how far a rule may go
- [Runtime changes](../operations/runtime-changes.md) — what can be changed without a restart
