# Runtime changes

Policy, guard, ranges and actors — changed without a deploy, and recorded.

← [Documentation](../index.md) · [Operations](index.md)

---

## Why any of this is mutable

Two things go stale between deploys, and both of them hurt.

**Published crawler ranges.** A stale list turns a verified crawler into an accused
impersonator — the address moved, the operator's file says so, and your copy does not.

**A rule set.** Sometimes a rule is wrong in a way you want to fix *now*, not at the next
deploy. That is exactly when the deploy pipeline feels longest.

Everything below is available as a method, as a [dashboard](dashboard.md) control behind its
own flag, and as an [event](index.md#events-and-hooks) so you have a trail.

---

## Rules

```ts
detector.updatePolicy(
  [...detector.policy.rules, { id: "allow-healthz", match: { path: "/healthz" }, action: "allow" }],
  { by: "ada@example.com" },
);
```

Validated first, swapped **atomically**, announced through `onWarning` and `policy-change`.
Invalid input throws and leaves the previous set standing.

**What it cannot change:** `falsePositivePolicy`, `fallbackAction` and
`terminalScoreThreshold`. No runtime edit can relax [the guard](../concepts/the-guard.md)
through this door.

## The guard

Its own method, its own event, its own dashboard flag:

```ts
detector.updateGuard({ falsePositivePolicy: "balanced" }, { by: "ada@example.com" });
// warning: Guard settings changed at runtime by ada@example.com: falsePositivePolicy strict → balanced.
```

Separate from `updatePolicy` because "which rules exist" and "how far a rule may go" are
different powers. A rule that overreaches is stopped by the guard; a change to the guard is
what decides whether anything stops it. `onGuardChange` carries the before and the after.

If you page on one thing in this document, page on this.

## Ranges

```ts
detector.updateCrawlerRanges("gptbot", await fetchOpenAiRanges());
detector.updateRanges("datacenter", ranges);
detector.listRanges();   // [{ name: "crawler:gptbot", size: 42 }, ...]
```

Parsed and validated before replacing the old set; invalid input throws while the previous
set stands, because a range set that silently matches nothing is worse than a stale one.

Two refusals specific to *crawler* ranges — a block wider than any crawler owns, and an
empty list — are covered in [verification](../detection/verification.md), because those
ranges do not merely describe a crawler, they verify one.

`range-change` is worth alerting on: the allowlist is the one list that stops detection
*running*. An address on it is not judged leniently, it is not judged at all.

### Keeping them fresh automatically

```ts
import { startCrawlerRangeRefresh } from "@osqd/bothandlerjs";
const stop = startCrawlerRangeRefresh(botHandler);   // twice a day, by default
```

Opt-in, because it makes outbound requests and a dependency-free package quietly fetching
URLs on a timer is not something to inherit by accident. It fails open, per source.

## Actors

```ts
detector.forgetActor(key, { by: "ada@example.com" });
detector.clearActor(key, 60 * 60_000, { by: "ada@example.com" });
```

The support-ticket path: somebody is being challenged, you have looked at their requests,
and you are satisfied. `forgetActor` drops what is remembered about them; `clearActor`
exempts them for a stated number of milliseconds, so the exemption expires on its own rather
than becoming a permanent hole nobody remembers opening. Both emit `actor-change`. See [actors](../concepts/actors.md).

---

## `by`, and the audit trail

Every mutating method takes `{ by }`. The dashboard fills it in from its own `auth` — a
basic credential names itself, and a custom `authorize` can return an identity instead of
`true`.

The library has no user model and does not want one. It carries the name it was given into
the warning and the event, so your trail can say *who* rather than only *what*:

```ts
detector.on("policy-change", ({ by, rules }) => auditLog.write({ who: by, count: rules.length }));
```

Nothing verifies the name. It is as trustworthy as whatever supplied it, which is your
authentication — the same thing that decides whether the change is allowed at all.

## Related

- [The dashboard](dashboard.md) — every one of these as a control, each behind its own flag
- [The guard](../concepts/the-guard.md) — the settings `updatePolicy` deliberately cannot reach
- [Verification](../detection/verification.md) — why crawler ranges are validated harder
- [Actors](../concepts/actors.md) — what `forgetActor` forgets
