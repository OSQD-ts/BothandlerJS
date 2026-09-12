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

### Naming what you already recognise

`labelActor` names one actor. For traffic you can describe in advance — your CI runners,
the office, a partner's feed — and for actors only your application can name, configure it
once instead:

```ts
new BotHandler({
  labels: {
    sources: [
      { label: "CI runner", cidrs: ["198.51.100.0/24"] },
      { label: "Health check", cidrs: ["10.0.4.0/28"], hideFromFeed: true },
    ],
    resolve: async (key) => lookupAccountName(key),
    resolveTimeoutMs: 500,
  },
});
```

| | |
| --- | --- |
| `sources` | Address ranges and what to call them. Matched in order, so a narrower range may precede a broader one. Each may also set `hideFromFeed`. |
| `resolve` | Names an actor the library cannot name by address — an account, a tenant, an API key's owner. |
| `resolveTimeoutMs` | How long to wait for one attempt. Default 500ms. |
| `ttlMs` | How long a resolved name is kept. Default one hour. |
| `retryAfterMs` | How long before an actor that resolved to no name is asked about again. Default one minute. |
| `max` | Most derived names held at once. Default 10,000. |

**No request waits for a name.** An address range is a lookup and is answered immediately;
`resolve` is started and the request goes on without it, so the name is there for that
actor's next request. A name is for whoever reads the dashboard, and nothing in detection
reads it — so there is nothing worth delaying a response for.

**A name somebody typed wins.** `labelActor` overrides anything derived here, because an
operator renaming an actor has said something the configuration did not know. Derived names
are held separately and the oldest is dropped silently when `max` is reached; they can
always be derived again, whereas a typed one cannot.

**What `resolve` is allowed to do.** Be slow, and throw. Both are handled: an attempt that
exceeds `resolveTimeoutMs` or throws is reported through `onError` and the actor is asked
about again after `retryAfterMs`, rather than being hammered on every request.

What it must not do is hang *silently*, and that is the failure this owns rather than
leaves to you. The obvious hand-rolled version marks a key in flight and clears the flag
when the lookup finishes — which is correct for a lookup that fails and wrong for one that
never returns at all: the flag is never cleared, the actor is never named, and nothing is
logged. The symptom is account ids in the feed where names should be, with no error
anywhere to explain it.

#### Naming an actor after the crawler it turned out to be

`assessment.identity` is a signature's id — `"googlebot"`. The name you would want to put
on screen is in the signature table, which is exported:

```ts
import { indexSignatures, BOT_SIGNATURES } from "@osqd/bothandlerjs";

const byId = indexSignatures(BOT_SIGNATURES);
const display = (identity: string): string => byId.get(identity)?.name ?? identity;

display("googlebot");          // "Googlebot"
display("facebook-external");  // "Facebook external hit"
```

Each entry carries `id`, `name`, `category`, `benign` and `verification`. Reach for this
rather than parsing a name out of an evidence summary — an evidence summary is prose, it is
written for a person to read, and it is free to change wording in any release.

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
