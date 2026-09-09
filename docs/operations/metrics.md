# Metrics

Counters, histograms, and the two series worth alerting on.

← [Documentation](../index.md) · [Operations](index.md)

---

On by default; a handful of integer increments per request.

```ts
detector.metrics();      // structured snapshot
detector.prometheus();   // Prometheus text exposition format
```

```ts
app.get("/internal/metrics", (_req, res) => res.type("text/plain").send(detector.prometheus()));
```

**Serve it somewhere only your scraper can reach.** The detector-firing series describe how
detection behaves, which is exactly what someone tuning a scraper would like to read.

## What is counted

Requests, verdicts, bot classes, actions, bypasses, detector firings and failures, the
challenge lifecycle, a latency histogram and a score histogram; plus a gauge for tracked
actors.

## The two worth alerting on

**`bothandler_downgrades_total`** — rules that asked to deny service and were refused for
lack of proof. A rising count means your policy is asking for something the evidence does
not support. It is the [guard's](../concepts/the-guard.md) own report card, and the single
most informative number here.

**`bothandler_verdicts_total{verdict="unknown"}`** — ordinary traffic. If this falls,
either your traffic changed or your detection did, and you want to know which.

## The one worth looking at *before* you move a threshold

**`bothandler_score_bucket`** — how suspicion is distributed across everything that was
scored, in ten buckets of ten points.

Proven assessments are counted by `bothandler_proven_total` instead: their score is 100 by
definition and decides nothing, so including them would put a spike at the top of the range
that means nothing. This is what the [dashboard's](dashboard.md) score distribution is drawn
from, which is why that chart and your alerting agree about how close ordinary traffic runs
to the line.

Moving `suspectThreshold` or a rule's `minScore` without looking at this is guessing. The
histogram tells you how many requests sit in the ten points you are about to cross.

## Per-detector timing is available and off

Total assessment duration is always measured. Timing each detector separately costs two
clock reads per detector per request, which on a twenty-detector set is forty reads to
measure work usually counted in microseconds. Worth paying while you tune, not forever:

```ts
new BotHandler({ metrics: { perDetectorTiming: true } });
```

It fills `detectorTimings` in the snapshot, adds `bothandler_detector_duration_ms_sum` and
`_count` to the Prometheus output, and puts an average beside each detector on the
dashboard — which is how you find out that one `io` detector costs more than the other
nineteen together.

Switch metrics off entirely with `metrics: false`.

## The counters that appear only when something is shadowed

A detector named in [`shadowDetectors`](../detection/shadow-mode.md) runs and decides
nothing, so its firings are counted apart from the ones that decided something. Folding
them together would put work into a chart of decisions that made none.

```
bothandler_shadow_firings_total{detector="path-novelty"} 312
bothandler_shadow_verdict_changes_total{verdict="suspected-bot"} 41
```

The second is the one to read. It counts the assessments the shadowed detectors *would
have moved*, keyed by the verdict they would have produced — so forty-one would-be
`suspected-bot`s against a `human` count that did not move is the shape of a detector
about to start challenging people. Both are absent from the output entirely while nothing
is shadowed, rather than sitting at zero.

## Related

- [The audit](audit.md) — because a counter cannot tell you a number is *unusual*
- [The guard](../concepts/the-guard.md) — what `bothandler_downgrades_total` is counting
- [Shadow mode](../detection/shadow-mode.md) — running a detector without letting it decide
- [The dashboard](dashboard.md) — these numbers, drawn
