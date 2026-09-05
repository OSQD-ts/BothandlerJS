# The safety guard

The mechanism that stops a guess from closing a door. If you read one page, read this one.

← [Documentation](../index.md)

---

Every bot detector eventually faces the same problem. The signals that catch sophisticated
automation — header consistency, TLS fingerprints, timing regularity, missing cookies —
are all *probabilistic*. Each one has a population of real people who trip it: somebody on
a privacy-hardened browser, behind a corporate proxy, using a screen reader, on a hotel
network, on a five-year-old phone.

The usual answer is to add the signals into a score and block above a threshold. That is
exactly the mistake. Points do not compose into proof. Two unrelated suspicions about an
unusual but entirely real browser reach 100 just as readily as two well-founded ones, and
the people who get caught are disproportionately the ones with the strongest reasons for
their unusual setup.

## What the guard does

It runs **after** a rule has been selected and before its action is applied:

```
rule matches  →  guard  →  decision
```

Under the default `strict` mode there is exactly one question — *is there proof?* — and
everything else is a downgrade:

```ts
if (!TERMINAL_ACTIONS.has(action)) return decision;   // not terminal, nothing to check
if (mode === "aggressive") return decision;           // the guard is off
if (assessment.certain) return decision;              // proven; the rule stands
return downgrade(decision);                           // a guess. Not this.
```

Terminal actions are `block`, `drop` and `redirect` — the three that end the request
without a way through. A downgraded decision becomes `fallbackAction` and records what it
was:

```ts
{
  action: "challenge",
  downgradedFrom: "block",
  downgradeReason:
    "Strict mode permits a terminal action only on proven evidence. This request's " +
    "verdict (suspected-bot, score 78) rests on probabilistic signals, any of which " +
    "a real client can trip.",
}
```

## Why it lives here and not in your rules

It cannot be forgotten in a rule, cannot be bypassed by a cleverly-worded predicate, and
does not depend on whoever wrote the rules understanding the certainty model. A rule that
says `action: "block"` on a probabilistic match is not a bug to be caught in review — it
is a thing the engine will simply decline to do.

Turning that off is a single, explicit, greppable line.

## The three modes

```ts
falsePositivePolicy: "strict"      // default
```

| Mode | A terminal action survives when |
| ---- | ------------------------------- |
| `strict` | There is `certain` evidence. Nothing else. |
| `balanced` | There is proof, **or** the score clears `terminalScoreThreshold` with at least two *independent strong* signals. |
| `aggressive` | Always. The guard is off. |

`balanced` requires independence deliberately: three signals from the same family are one
observation, and `independentStrongSignals` counts families rather than pieces. Even so,
real people do trip two independent strong signals — a hardened browser behind a corporate
proxy is the usual pair — so `balanced` will eventually deny somebody who should have been
served. That is the trade it is; make it knowingly.

`aggressive` means every rule does exactly what it says, on proof or on suspicion alike.
The people it turns away first are the ones with the most unusual and most legitimate
setups.

## The fallback

```ts
fallbackAction: "challenge"   // default when a challenge is configured, otherwise "tag"
```

What a stopped rule becomes. **It cannot be terminal**, and that is enforced rather than
advised: a `block` fallback would make every downgrade deny the request the downgrade
existed to protect — and the decision would still be *recorded* as a guard stop, so the
metric that exists to catch this would report success.

## Watching it

`bothandler_downgrades_total` is one of the two series worth alerting on. A rising count
means your rules are asking to deny requests the evidence does not support — the guard
working, and your policy needing attention.

The [dashboard](../operations/dashboard.md) breaks guard stops down by the rule that
overreached, which is usually enough to find the one at fault in a few seconds.

## Changing it

The guard is fixed at construction unless something opts in:

```ts
detector.updateGuard({ falsePositivePolicy: "balanced" }, { by: "ada@example.com" });
```

See [Runtime changes](../operations/runtime-changes.md). The dashboard exposes this behind
a control flag separate from its rule editor, because "which rules exist" and "how far a
rule may go" are different powers.

## Related

- [Evidence and certainty](evidence.md) — what "proof" means, precisely
- [Actions](../policy/actions.md) — which are terminal and which are not
- [Presets](../policy/presets.md) — every shipped policy keeps `strict`
