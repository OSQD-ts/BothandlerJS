# Lesson 4 — The safety guard

**Goal:** watch a rule you wrote get overruled, and understand why that is the most
valuable behaviour in the library.

← [Course](index.md) · Prev: [Verdicts and scores](03-verdicts-and-scores.md) · Next: [The detectors](05-detectors.md)

---

## Assess, then decide

Detection and policy are separate calls, on purpose:

```js
const assessment = await detector.assess(facts);   // what is this client?
const decision = detector.decide(assessment);      // what do we do about it?
```

*What is this client* and *what should we do about it* are different questions with
different lifetimes. `decide` is synchronous and pure, which is what lets you replay a
policy over a log file, preview a rule change against real traffic, and test both halves
separately.

The guard lives in `decide`.

## Do this

Write a rule that blocks anything suspected — deliberately too aggressive:

```js
import { BotHandler, createFacts } from "@osqd/bothandlerjs";

const detector = new BotHandler({
  rules: [{ id: "block-suspects", match: { verdict: "suspected-bot" }, action: "block" }],
  suspectThreshold: 40,
});

// A scraper that copied a User-Agent and nothing else.
const spoof = createFacts({
  method: "GET",
  url: "/books",
  ip: "203.0.113.55",
  headers: {
    host: "serif.example",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    accept: "*/*",
  },
});

const assessment = await detector.assess(spoof);
const decision = detector.decide(assessment);

console.log(`verdict ${assessment.verdict}  score ${assessment.score}  certain ${assessment.certain}`);
console.log(`action ${decision.action}  rule ${decision.rule}  downgradedFrom ${decision.downgradedFrom}`);
console.log(decision.downgradeReason);
```

### Checkpoint

```
verdict suspected-bot  score 45  certain false
action tag  rule block-suspects  downgradedFrom block
Strict mode permits a terminal action only on proven evidence. This request's verdict
(suspected-bot, score 45) rests on probabilistic signals, any of which a real client can
trip.
```

**Your rule said `block`. The request was tagged.**

The rule still fired — `decision.rule` names it — and the guard replaced the action,
recorded what it replaced, and explained itself in a sentence you can put in front of an
operator. Nothing was silent.

## Why it is a separate pass

The guard runs **after** a rule is selected, not inside the rule. Anywhere else it can be
forgotten.

Inside a rule, it would have to be written correctly by every author of every rule,
including at 3am during an incident, including by somebody who has not read this course.
After selection, it cannot be forgotten in a rule, worked around by a clever predicate, or
bypassed by copying an example from a blog post. Relaxing it is one explicit, greppable
setting.

## Now give it proof

Same rule set, a client that declares itself:

```js
const proven = createFacts({
  method: "GET", url: "/books", ip: "203.0.113.10",
  headers: { host: "serif.example", "user-agent": "curl/8.4.0" },
});
const d = detector.decide(await detector.assess(proven));
console.log(`action ${d.action}  rule ${d.rule}  downgradedFrom ${d.downgradedFrom ?? "(not downgraded)"}`);
```

```
action allow  rule default  downgradedFrom (not downgraded)
```

Surprised? **The rule did not match.** `curl` is `confirmed-bot`, not `suspected-bot`, so
`block-suspects` never applied and the default action took over. The guard was not
involved at all.

That is a useful accident to hit early: a rule that matches the wrong verdict is a much
more common bug than a rule the guard overrules.

## The three terminal actions

`block`, `drop` and `redirect` withhold the page. Everything else — `allow`, `log`, `tag`,
`delay`, `rate-limit`, `challenge`, `custom` — leaves the client a way through.

Only the terminal three are gated. [Lesson 10](10-actions-and-presets.md) ranks all ten by
what each costs somebody who turns out to be a person.

## The three modes

```js
new BotHandler({ falsePositivePolicy: "strict" })   // default
```

| Mode | A terminal action is allowed when |
| ---- | --------------------------------- |
| `strict` | the verdict is **proven**. Nothing else |
| `balanced` | proven, **or** the score is at or above `terminalScoreThreshold` (default 85) |
| `aggressive` | any bot verdict, proven or not |

Try `balanced` with the spoofed request above and it is still tagged — 45 is under 85. Push
`suspectThreshold` down and the score does not change; the score is what it is, and the
threshold only decides what to call it.

**`aggressive` will deny real people.** It exists because some operators genuinely need it —
an internal API where every human is authenticated, say — and because a setting you have to
write down is better than one you can reach by accident. If you find yourself reaching for
it during an incident, read [`under-attack`](../policy/presets.md#under-attack) first: it is
designed for exactly that moment and keeps the guard on.

## The fallback

When the guard replaces a terminal action, it substitutes `fallbackAction` — `challenge`
by default. Above you got `tag`, not `challenge`, because no challenge secret is
configured; a rule asking for a challenge without one degrades to `tag` and warns. You will
fix that in [lesson 11](11-the-challenge.md).

`fallbackAction` **cannot itself be terminal**, and the library refuses at construction:

```js
new BotHandler({ fallbackAction: "block" });
// throws — a terminal fallback would make every downgrade deny the request the
// downgrade existed to protect, while still recording it as a guard stop
```

## Exercise

Count the downgrades over a mixed batch, and notice what that number is for.

```js
const detector = new BotHandler({
  rules: [{ id: "block-suspects", match: { verdict: "suspected-bot" }, action: "block" }],
  suspectThreshold: 40,
  onDowngrade: ({ decision }) => console.log(`  guard stopped rule "${decision.rule}"`),
});
```

Run several requests through it. Then read the counter:

```js
console.log(detector.metrics().downgrades);
```

<details>
<summary>What that number means</summary>

`bothandler_downgrades_total` is the single most informative number this library exposes.
A rising count means **your policy is asking for something the evidence does not
support** — and the guard is absorbing the difference.

Alert on it. If it climbs after a deploy, you changed a rule; if it climbs on its own, your
traffic changed. Either way it is telling you the policy and reality have drifted apart,
and the guard is the only reason nobody has been wrongly refused yet.

[Lesson 13](13-operating-it.md) wires it up properly.
</details>

## What you learned

- `assess` and `decide` are separate; the guard lives in `decide`, after rule selection
- A rule can fire and still not get the action it asked for — visibly, with a reason
- Only `block`, `drop` and `redirect` are gated
- `fallbackAction` cannot be terminal, and that is enforced at construction
- `downgrades` is the number to watch

## Reference

- [The safety guard](../concepts/the-guard.md)
- [Actions](../policy/actions.md) — ordered by what each costs a person
- [Design decisions](../design/decisions.md) — why the guard is a separate pass

Next: [The detectors](05-detectors.md) — where the evidence actually comes from.
