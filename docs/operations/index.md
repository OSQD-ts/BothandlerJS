# Operations

Knowing what the library is doing to your traffic, and changing it without a deploy.

← [Documentation](../index.md)

---

| Page | For |
| ---- | --- |
| **This page** — events and hooks | wiring the engine into your own logging, paging and queues |
| [The dashboard](dashboard.md) | seeing individual requests and the evidence behind them |
| [Embedding it](embedding.md) | dropping it into a page you already have |
| [Metrics](metrics.md) | counters, histograms, Prometheus |
| [The audit](audit.md) | noticing that the traffic changed *shape* |
| [Notifications](notifications.md) | webhooks, Slack, batching and redaction |
| [Runtime changes](runtime-changes.md) | policy, guard, ranges and actors, live |

---

## Events and hooks

Everything the engine concludes is available as an event, in two forms that are the same
mechanism: a callback in the config, or a subscription you can add and remove.

```ts
const detector = new BotHandler({
  onDenial:    ({ assessment, decision }) => audit.record(assessment.actor.key, decision.rule),
  onDowngrade: ({ decision }) => pager.warn(`rule ${decision.rule} asked for more than its evidence`),
  onAnomaly:   (anomaly) => yourAlerting.send(anomaly.severity, anomaly.summary),
});

// Or later, and more than once, and removable:
const stop = detector.on("denial", ({ assessment }) => log.info({ actor: assessment.actor.key }));
stop();
```

| Event | `onX` | Fires when |
| ----- | ----- | ---------- |
| `assessment` | `onAssessment` | Every assessment, including the ones that concluded nothing. The firehose. |
| `decision` | `onDecision` | Every decision, with the assessment behind it. |
| `denial` | `onDenial` | A request was actually denied — `block`, `drop` or `redirect`. |
| `downgrade` | `onDowngrade` | The [guard](../concepts/the-guard.md) replaced a terminal action. **The one worth paging on a rise in.** |
| `challenge` | `onChallenge` | A [challenge](../challenge/index.md) was issued, solved or rejected. |
| `detector-failure` | `onDetectorFailure` | A detector threw or timed out. Operational, not about traffic. |
| `policy-change` | `onPolicyChange` | The rule set was replaced at runtime. Your audit trail. |
| `guard-change` | `onGuardChange` | The guard settings changed at runtime, with the before and the after. **The other one worth paging on.** |
| `range-change` | `onRangeChange` | A range set was replaced — an allowlist entry added, a crawler's ranges refreshed. |
| `actor-change` | `onActorChange` | One [actor's](../concepts/actors.md) memory was forgotten, or it was cleared as human, by hand. |
| `anomaly` | `onAnomaly` | The [audit](audit.md) noticed the traffic change shape. |
| `warning` | `onWarning` | A misconfiguration, at startup or since. |
| `error` | `onError` | A detector, sink or store failed. |

### Why `denial` and `downgrade` are separate events

They are *derived* rather than left for you to compute from `decision`, and that is
deliberate: "was this request refused" and "did the guard stop a rule" are the two
questions every integration asks, and three integrations deriving them separately is three
chances to disagree about the answer.

### Why `guard-change` is separate from `policy-change`

For the same reason the dashboard gates them separately: "which rules exist" and "how far a
rule may go" are different powers with different consequences. A rule that overreaches is
stopped by the guard; a change to the guard is what decides whether anything stops it.

If you alert on one runtime change, alert on this one — and on `range-change`, because the
allowlist is the one list that stops detection *running*: an address on it is not judged
leniently, it is not judged at all.

### `by` — who asked

All four runtime-change events carry **`by`**, when whatever made the change could say who
asked for it. Every mutating method takes a `{ by }` alongside its arguments, and the
dashboard fills it in from its own `auth`.

```ts
detector.updateGuard({ falsePositivePolicy: "balanced" }, { by: "ada@example.com" });
// warning: Guard settings changed at runtime by ada@example.com: falsePositivePolicy strict → balanced.
```

The library has no user model and does not want one; it carries the name it was given into
the warning and the event, so an audit trail can say *who* rather than only *what*. See
[runtime changes](runtime-changes.md).

### None of them can hurt a request

A handler that throws is caught, reported once through `onError`, and the remaining
handlers still run — the same isolation the [detector pipeline](../detection/index.md)
gets. None is awaited: returning a promise is fine and its rejection is reported, but the
response never waits for your webhook.

That is the whole integration surface. A logger, a pager, a queue, a metrics client, a
webhook of your own — each is a function you pass in. Where you want batching, deduplication
and redaction as well, [the notification hub](notifications.md) already has them; where you
want the raw event, take it here.

## Related

- [Metrics](metrics.md) · [The audit](audit.md) · [Notifications](notifications.md)
- [The dashboard](dashboard.md) — all of the above, rendered
- [The feed filter](filters.md) — the query language, saved filters and exclusions
- [Configuration reference](../reference/configuration.md)
