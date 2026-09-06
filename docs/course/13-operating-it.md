# Lesson 13 — Operating it

**Goal:** see what the policy is doing to real traffic, and know which two numbers to alert
on.

← [Course](index.md) · Prev: [Going live](12-going-live.md) · Next: [Scaling](14-scaling.md)

---

## The dashboard

Counters tell you *how much*. The dashboard tells you **which requests, and why** — every
assessment as it lands, and on any row you open, the individual evidence with its certainty
tier and, for proven ones, the written basis.

```js
const dashboard = await detector.serveDashboard({
  port: 9674,
  title: "serif",
  auth: { username: "ops", password: process.env.DASHBOARD_PASSWORD },
});
console.log(dashboard.url);
```

That is the whole integration: it listens on a port of its own, subscribes to the handler
you called it on, and returns a handle with a `close()`.

Four screens — the live feed, actors, statistics, and the policy editor. Open a row and you
see the evidence that produced the verdict; that is the view that answers "why was this
customer challenged?".

### Before it goes anywhere real

**It reports on one process.** Behind a load balancer with eight pods you are looking at an
eighth of your traffic. The page names the instance, which is the honest amount of help it
can give.

**Its feed is memory-only** and bounded. It is a live view, not a log.

**Everything it can *do* is behind a flag**, and each flag is separate:

```js
controls: { reset: true, editPolicy: true, editGuard: true, editRanges: true }
```

`editGuard` is separate from `editPolicy` deliberately: a rule that overreaches is stopped
by the guard, and this changes whether anything stops it. They read like similar powers and
are not.

**What it *shows* is separate again** — `sections` — and enforced on the server, so a
switched-off section's endpoint answers 403 and its fields never leave the process:

```js
// What an analyst gets: the shape of the traffic, without naming individuals.
await detector.serveDashboard({
  port: 9684,
  sections: { evidence: false, policy: false },
  redact: { maskIp: true },
});
```

That combination is worth understanding. The dashboard people watch all day need not be the
one that names individuals, or the one that explains your detection to whoever is scraping
you.

**It does not have to be its own page.** The same dashboard is also a custom element, so it
can live inside the admin tool your team already opens, rather than behind a second link
they have to remember:

```html
<bot-dashboard src="/_bots"></bot-dashboard>
<script type="module">
  import { defineBotDashboard } from "@osqd/bothandlerjs/element";
  defineBotDashboard();
</script>
```

`sections` and `redact` above still apply — they are enforced on the server, and embedding
changes nothing about that. What the element adds is which screens appear and how it looks.
[Embedding it](../operations/embedding.md) has the whole of it, including what putting the
dashboard inside your own page costs you.

## Metrics

On by default; a handful of integer increments per request.

```js
app.get("/internal/metrics", (_req, res) => res.type("text/plain").send(detector.prometheus()));
```

**Serve it where only you can reach it.** The detector-firing series describe how your
detection behaves, which is exactly what somebody tuning a scraper would like to read.

### The two to alert on

**`bothandler_downgrades_total`** — rules that asked to deny and were refused for lack of
proof. You met it in [lesson 4](04-the-guard.md). A rising count means your policy is asking
for something the evidence does not support.

**`bothandler_verdicts_total{verdict="unknown"}`** — ordinary traffic. If this falls, either
your traffic changed or your detection did, and you want to know which.

### The one to read before moving a threshold

**`bothandler_score_bucket`** — how suspicion is distributed across everything scored, in
ten buckets of ten points. Proven assessments are counted separately by
`bothandler_proven_total`; their score is 100 by definition and would put a meaningless
spike at the top.

Moving `suspectThreshold` or a rule's `minScore` without looking at this is guessing. The
histogram tells you how many requests sit in the ten points you are about to cross.

### Per-detector timing is available and off

Timing each detector costs two clock reads per detector per request — forty on a
twenty-detector set, to measure work counted in microseconds. Worth paying while you tune:

```js
new BotHandler({ metrics: { perDetectorTiming: true } });
```

It is how you find out that one `io` detector costs more than the other nineteen together.

## The traffic audit

Counters cannot tell you a number is *unusual*, and bot traffic is not a level — it is an
event. The number that matters is not "12% of requests are bots" but "12% now, 2% for the
hour before".

```js
new BotHandler({
  audit: {
    windowMs: 5 * 60_000,
    baselineMs: 60 * 60_000,
    minSamples: 50,
    cooldownMs: 15 * 60_000,
  },
  onAnomaly: (anomaly) => pager.send(anomaly.severity, anomaly.summary),
});
```

**The baseline ends where the window begins.** A baseline containing the window would be
partly made of the thing being measured, and a large enough spike would raise its own bar
until it stopped looking like one.

| Check | Fires when |
| ----- | ---------- |
| `bot-share-spike` | automation is a much larger share than the baseline |
| `traffic-spike` | volume far above the baseline rate |
| `denial-spike` | a much larger share is being denied — **read these before assuming they are all bots** |
| `guard-stop-spike` | the guard is refusing far more rules than usual |
| `human-share-drop` | traffic reading as human has fallen away |
| `detector-failures` | detectors erroring or timing out |
| `challenge-solve-rate` | nearly everything challenged is passing — **high is the bad direction** |

That last one is the closest to this library's thesis. Every other check asks whether the
*traffic* changed shape; this asks whether the mitigation is landing on the right
population. A proof of work is trivial for a browser and trivial for a competent scraper —
what it actually costs is a few seconds of somebody's afternoon. So when nearly everything
challenged goes on to pass, the challenges are not filtering bots out, they are **taxing
people**. From every other angle a solved challenge looks like a challenge that worked,
which is why it needs saying out loud.

Every check has a **floor** as well as a ratio — a quiet site at 3am produces "800% more
bots" from four requests, and an alerting system that cries wolf at 3am gets muted — and a
**cooldown**, because a spike lasting an hour is one event, not sixty.

## Events

Everything the engine concludes is available as a callback or a subscription:

```js
const stop = detector.on("denial", ({ assessment, decision }) =>
  log.info({ actor: assessment.actor.key, rule: decision.rule }),
);
```

| Event | Fires when |
| ----- | ---------- |
| `assessment` | every assessment. The firehose |
| `decision` | every decision |
| `denial` | a request was actually refused |
| `downgrade` | the guard replaced a terminal action |
| `challenge` | one was issued, solved or rejected |
| `detector-failure` | a detector threw or timed out |
| `policy-change` / `guard-change` / `range-change` / `actor-change` | somebody changed something at runtime |
| `anomaly` | the audit noticed a change of shape |
| `warning` / `error` | misconfiguration; a component failed |

**None of them can hurt a request.** A handler that throws is caught and reported once
through `onError`, the rest still run, and none is awaited — returning a promise is fine and
the response never waits for your webhook.

## Notifications

```js
notifications: {
  sinks: [consoleNotifier(), slackNotifier({ url }), webhookNotifier({ url, secret })],
  filter: { types: ["denial", "downgrade", "anomaly"], minScore: 70 },
  redaction: { maskIp: true },
  dedupeWindowMs: 60_000,
  maxPerWindow: 200,
}
```

Two properties decide whether alerting is an asset or a liability under bot load. **It never
blocks a request** — a wedged webhook slows nothing. **It has a ceiling** — repeats collapse,
a global cap catches distributed traffic where every event is genuinely distinct, and the
suppressed count is reported when the window rolls, so a quiet channel is never mistaken for
quiet traffic.

Addresses are masked to a `/24` or `/64` on the way *out*, so detection still sees
everything.

## Exercise

Serif has been live on `monitor-only` for a week. What do you look at, in what order, to
decide whether to enforce?

<details>
<summary>Answer</summary>

1. **`bothandler_verdicts_total`** — what is the actual mix? If `unknown` is not the large
   majority, something is misconfigured, most likely the client IP.
2. **The dashboard's live feed, filtered to anything not `unknown`.** Open rows and read the
   evidence. You are looking for the integration you forgot: a partner's nightly sync, a
   status prober, the marketing team's link checker, your own renderer.
3. **`bothandler_score_bucket`** — where does suspicion actually sit? That tells you what
   `minScore: 70` would catch on *your* traffic rather than in general.
4. **`bothandler_downgrades_total`** — on `monitor-only` this should be zero, because
   nothing asks for a terminal action. If it is not, your rules are not what you think.
5. **`npx @osqd/bothandlerjs replay` over the week's access log** with the policy you are
   considering, and read every request it would have refused.

Only then enforce — and allowlist what step 2 found *first*.

Step 5 is [lesson 16](16-proving-it.md), and it is the one that catches what the others
miss.
</details>

## What you learned

- The dashboard shows which requests and why; it reports on one process and is bounded
- `sections` and `controls` are separate powers, enforced server-side
- Alert on `downgrades_total` and on `unknown`; read `score_bucket` before moving a threshold
- The audit compares a window against the baseline before it, with floors and cooldowns
- A high challenge solve rate is the bad direction
- Nothing in the observation path can slow or break a request

## Reference

- [The dashboard](../operations/dashboard.md) · [Embedding it](../operations/embedding.md)
- [Metrics](../operations/metrics.md) · [The audit](../operations/audit.md)
- [Notifications](../operations/notifications.md)

Next: [Scaling and changing it live](14-scaling.md).
