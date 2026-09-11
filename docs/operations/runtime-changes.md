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

### Labels, and what a label can switch

```ts
detector.labelActor("10.0.4.17", "office egress");                                   // a name
detector.labelActor("10.0.4.18", { name: "uptime monitor", skipAnalysis: true });     // not analysed
detector.labelActor("10.0.4.19", { name: "load balancer", hideFromFeed: true });      // kept off the feed
detector.labelActor("10.0.4.17", undefined);                                         // removed
```

A **name on its own changes nothing**, and that has always been the point of it: a note
that could move a verdict would make writing notes a way to be wrong about people at scale.
What a label can also carry is two explicit switches, both of which only ever reduce what
happens to a request:

| Switch | What happens to the actor's requests |
| --- | --- |
| `hideFromFeed` | Kept out of the live feed. Still analysed, decided, acted on and counted. The feed says how many it is hiding and can show them again — hidden traffic is still traffic. |
| `skipAnalysis` | Not analysed at all, exactly like an allowlisted address: no detector runs, no rule sees it, and it does not enter the feed. Counted as `bypassed.label`. Keyed by actor, so it works for an actor key that is not an IP. |

`skipAnalysis` is allowlisting by another name and deserves the same care; the dashboard
puts it behind the same `controls.editRanges` as the allowlist, and says what it does in
words the moment the box is ticked.

Labels are kept apart from the actors they name, so they last until somebody removes them
— an actor that ages out of the registry comes back still named — and they apply to a key
the handler has not seen yet. That independence is not a nicety: a skipped actor is never
recorded, so a switch stored on its state would have aged out with it and the actor would
have been judged again on its next request, silently. `forgetActor` removes the label along
with everything else. At most 10,000 actors can be labelled; past that it warns rather than
dropping one.

On a dashboard that masks addresses, names are shown keyed by network, and the switches are
not sent: hiding one actor by label there would hide everybody sharing its network.

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
