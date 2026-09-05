# The audit

Noticing that the traffic changed shape.

← [Documentation](../index.md) · [Operations](index.md)

---

## Why this exists

[Counters](metrics.md) tell you what is happening. They do not tell you it is *unusual*,
and bot traffic is not a level — it is an **event**. A scrape starts, a scanner sweeps a
range, somebody points a stuffing tool at your login form. The number that matters is not
"12% of requests are bots" but "12% now, 2% for the hour before".

So the audit keeps a short **window**, compares it against the **baseline that precedes
it**, and raises a structured anomaly when a check clears its bar.

```ts
new BotHandler({
  audit: {
    windowMs: 5 * 60_000,        // the stretch being judged
    baselineMs: 60 * 60_000,     // what it is compared against — the hour before it
    intervalMs: 60_000,          // how often the comparison runs
    minSamples: 50,              // below this, no check may speak
    cooldownMs: 15 * 60_000,     // one alert per check per quarter hour
  },
  onAnomaly: (anomaly) => pager.send(anomaly.severity, anomaly.summary),
});
```

```
critical — Automated traffic is 87.3% of assessed requests, against 0.0% in the
           baseline — where there was none.
warning  — The guard stopped 37 terminal action(s) — 35.9% of traffic. Your rules
           are asking to deny requests the evidence does not prove.
critical — Traffic is 298 requests a minute, against a baseline of 1.5 (198.7x).
```

**The baseline ends where the window begins.** A baseline that contained the window would
be partly made of the thing being measured, and a large enough spike would raise its own
bar until it stopped looking like one.

## What ships

| Check | Fires when |
| ----- | ---------- |
| `bot-share-spike` | Automation is a large and much larger share of traffic than the baseline. A baseline of zero is the loudest case, not a reason to stay quiet. |
| `traffic-spike` | Volume is far above the baseline rate. |
| `denial-spike` | A much larger share of requests is being denied. **Read these before assuming they are all bots.** |
| `guard-stop-spike` | The [guard](../concepts/the-guard.md) is refusing far more rules than usual — your policy is asking to deny requests the evidence does not prove. |
| `human-share-drop` | Traffic that reads as human has fallen away. Either your traffic changed or your detection did. |
| `detector-failures` | Detectors are erroring or timing out. Detection is degraded — usually a resolver or a store, not the traffic. |
| `challenge-solve-rate` | Nearly everything being challenged is passing. **High is the bad direction.** |

### Why `challenge-solve-rate` reads backwards

It is the odd one out and the closest to this library's own thesis. Every other check asks
whether the *traffic* changed shape; this one asks whether the mitigation is landing on the
right population.

A proof-of-work [challenge](../challenge/index.md) is trivial for a browser and trivial for
a competent scraper — what it actually costs is a few seconds of somebody's afternoon — so
when nearly everything challenged goes on to pass, the challenges are not filtering bots
out, they are **taxing people**. From every other angle a challenge that gets solved looks
like a challenge that worked, which is precisely why this needs saying out loud.

### Floors and cooldowns

Every check has a **floor** as well as a ratio, because a quiet site at 3am produces "800%
more bots" from four requests, and an alerting system that cries wolf at 3am gets muted —
which is worse than not having one.

And every one has a **cooldown**: a spike lasting an hour is one event, not sixty.

## Your own checks

```ts
audit: {
  extraChecks: [{
    id: "checkout-scraping",
    description: "Bots on the checkout funnel specifically",
    evaluate: ({ window, baseline }) =>
      window.botShare > 0.4 && window.botShare > baseline.botShare * 2
        ? { id: "checkout-scraping", severity: "warning", metric: "bot share",
            value: window.botShare, baseline: baseline.botShare,
            summary: `Checkout is ${(window.botShare * 100).toFixed(0)}% automated.` }
        : undefined,
  }],
}
```

A check that throws is skipped, not a reason for the audit to stop running. `checks`
replaces the built-in set entirely; `extraChecks` adds to it.

## Asking it yourself

The timer is a convenience, not the mechanism. `handler.audit` is the object, and
`runAudit()` runs the checks now and emits whatever they found — which is what a health
endpoint, a cron job or a test with a manual clock wants:

```ts
app.get("/internal/traffic", (_req, res) => res.json(detector.audit?.summary()));

const anomalies = detector.runAudit();
```

Anomalies also reach configured [notification sinks](notifications.md) as `type: "anomaly"`
events, and land in the [dashboard's](dashboard.md) notices panel beside your startup
warnings. Switch the whole thing off with `audit: false`.

## Related

- [Metrics](metrics.md) — the counters this reads
- [Notifications](notifications.md) — where an anomaly goes
- [The guard](../concepts/the-guard.md) — what `guard-stop-spike` is about
