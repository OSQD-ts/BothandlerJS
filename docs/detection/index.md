# How detection works

The pipeline a request goes through, what it costs, and what comes out the other end.

← [Documentation](../index.md)

---

```
facts → bypass checks → cheap detectors ─┐
                        io detectors ────┼→ combine → assessment → policy → decision
                        confirming ──────┘
```

Three calls, and you can stop after any of them:

```ts
const facts = createFacts({ method, url, headers, ip });   // normalise
const assessment = await detector.assess(facts);           // what is this?
const decision = detector.decide(assessment);              // what do we do?
const { outcome } = await detector.handle(facts);          // all three, plus the action
```

`assess` never decides and `decide` never inspects. That separation is what makes the
[replay](../testing/replay.md), the [corpus](../testing/corpus.md) and the dashboard's
policy preview possible: `decide` is **pure**, so a candidate policy can be run over
recorded assessments as many times as you like and nothing about the running system moves.

## Before any detector runs

Two checks short-circuit everything:

| | |
| --- | --- |
| `ignorePaths` | Health checks, static assets, your own instrumentation. |
| `allowlist` | Addresses that are **not judged at all** — see [design decisions](../design/decisions.md). |

Either produces an assessment with `bypass` set and no evidence. It is counted (so the
dashboard can say how much traffic detection actually ran on) and nothing else happens.

## The three stages

**Cheap detectors** are synchronous by contract and run *without* an `await`. That is not
micro-optimisation: `await` on a non-promise still yields a microtask turn, so awaiting
each of a dozen detectors put a dozen scheduler round-trips on every request to your site
— which dominated the cost of a clean browser request. A detector that returns a promise
anyway is collected and awaited with the rest, so the contract is enforced by behaviour
rather than by trust.

**`io` detectors** run concurrently under `detectorTimeoutMs` (default 300 ms). Mislabelling
one as `cheap` would put an unbounded await on the request path, so the engine times out
any promise a `cheap` detector returns as well.

**Confirming detectors** run only when a signature matched. With no claimed identity there
is nothing to confirm and no lookup to make, which is why a normal browser request never
touches DNS.

## Failure is not the visitor's problem

A detector that throws or times out is recorded as a `DetectorFailure`, reported through
`onDetectorFailure`, and the assessment continues with the evidence it has. A resolver
being down degrades detection; it must never take down the site the detection protects.

```ts
assessment.failures;   // [{ detector, reason: "timeout" | "error", message }]
```

The same rule holds one level up: an unexpected failure inside an
[adapter](../integration/adapters.md) serves the request. A bot filter that fails closed
is an outage with extra steps.

## What comes out

```ts
interface Assessment {
  requestId: string;        // random per request, safe to log and echo
  verdict: Verdict;         // confirmed-bot | verified-bot | suspected-bot | human | unknown
  botClass: BotClass;
  identity?: string;        // "googlebot", when something named itself
  score: number;            // 0–99, or 100 for proven
  confidence: number;       // 0–1, unrounded
  certain: boolean;         // ← the field that gates terminal actions
  evidence: Evidence[];     // bot-pointing, strongest first
  humanEvidence: Evidence[];
  actor: ActorSnapshot;     // history at the time of this request
  durationMs: number;
  failures: DetectorFailure[];
  facts: RequestFacts;
  bypass?: "allowlist" | "ignored-path";
}
```

See [verdicts, classes and scores](../concepts/verdicts.md) for which field to read when,
and [evidence and certainty](../concepts/evidence.md) for how the evidence became a score.

## Asking about a request that is not happening

```ts
const assessment = await detector.assess(facts, { record: false });
```

A **dry run**. Every detector runs and the verdict is real — and nothing is written down:
no counter moves, no actor state changes, no `assessment` event fires, no notification is
sent. Asking what the engine thinks of a request does not become part of the answer to
"what is my traffic doing?".

Reach for it wherever you want an opinion about a request nobody made: a support ticket
("why is this customer being challenged?"), a rule you are drafting, a test. It is what
`bothandlerjs explain` and the dashboard's request tester run on.

The one thing it cannot see is history. It gets an actor with no past, so `cadence`,
`crawl-breadth` and `rate-anomaly` have nothing to read. What it answers precisely is
*what would this look like as a first request* — which is what a support ticket is asking
anyway.

## What it costs

Measured on the clean-browser path, which is the overwhelmingly common case and the one
where nothing short-circuits because nothing fires:

```
assess — clean browser     ~9 us     ~104,000 ops/s
handle — clean browser    ~12 us      ~83,000 ops/s
```

`npm run bench` reproduces it; `npm run bench:guard` is the CI ratchet that stops it
quietly getting worse. Turn on `metrics.perDetectorTiming` while tuning to see where the
time goes, and turn it off afterwards — it is two clock reads per detector per request.

## Related

- [The detectors](detectors.md) — all twenty in detail
- [Writing a detector](writing-a-detector.md)
- [Policy](../policy/index.md) — what happens to an assessment next
