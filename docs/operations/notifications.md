# Notifications

Webhooks, Slack and your own sinks — with a ceiling, because this fires under bot load.

← [Documentation](../index.md) · [Operations](index.md)

---

```ts
notifications: {
  sinks: [consoleNotifier(), slackNotifier({ url }), webhookNotifier({ url, secret })],
  filter: { types: ["action", "downgrade", "error"], minScore: 70 },
  redaction: { maskIp: true },
  dedupeWindowMs: 60_000,
  maxPerWindow: 200,
}
```

## The sinks that ship

| Sink | Notes |
| ---- | ----- |
| `consoleNotifier()` | development, and a reasonable default in a container |
| `webhookNotifier({ url, secret })` | HMAC-signed, with the timestamp *inside* the signed payload; retries with backoff; per-attempt timeout |
| `slackNotifier({ url })` | an incoming webhook |
| `notifyJsNotifier({ endpoint, token, channel })` | the sibling [NotifyJS](https://github.com/OSQD-ts) hub, over its HTTP ingest |

Ingest is **off** on a NotifyJS hub until you turn it on — `notifyjs serve --ingest`, then
`notifyjs token create --role oncall` for the token — and a hub with it off answers `404`
rather than confirming the feature exists. Each refusal is reported as the fix it needs:
`421` is a bearer token over plain HTTP from off-box, `401` an unknown or revoked token,
`403` a token whose role cannot `notify.send`, `429` its rate limit.

Your own is one method — implement `Notifier`. If you want the raw event with no batching
at all, take it from [the events](index.md#events-and-hooks) instead.

## The two properties that matter under load

Alerting is an asset or a liability depending on exactly these.

**It never blocks a request.** `emit` returns immediately and a wedged webhook slows
nothing. This is the same guarantee the event hooks give, for the same reason: nothing in
this library may put an unbounded await on the request path.

**It has a ceiling.** Repeats from one actor collapse within `dedupeWindowMs`; a global
`maxPerWindow` catches distributed traffic where every event is genuinely distinct; and the
**suppressed count is reported when the window rolls**, so a quiet channel is never mistaken
for quiet traffic.

Without both of those, the first real scrape either takes your site down or drowns the
channel you would have used to notice it.

## Redaction

Addresses are masked to a `/24` or `/64` before an event leaves the process, and `Cookie`,
`Authorization` and friends are stripped unconditionally.

**Redaction runs on the way out**, so detection still sees everything. The engine needs the
full address to key an [actor](../concepts/actors.md) and match a range; your Slack channel
does not.

## Filtering

`filter` decides what is worth sending at all — by event type, and by a score floor:

```ts
filter: { types: ["denial", "downgrade", "anomaly"], minScore: 70 }
```

A good starting set is exactly those three: something was refused, the guard stopped a rule,
or the [audit](audit.md) noticed a change. `assessment` is a firehose and belongs in a log,
not a chat channel.

## Related

- [Events and hooks](index.md#events-and-hooks) — the raw, unbatched surface
- [The audit](audit.md) — the source of `anomaly` events
- [The dashboard](dashboard.md) — the notices panel these also land in
