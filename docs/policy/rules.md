# Matching requests

Every field a rule can match on, and what each one is good for.

← [Documentation](../index.md) · [Policy](index.md)

---

```ts
interface Rule {
  id: string;                    // stable; names every decision and log line it produces
  match: MatchSpec | ((assessment: Assessment) => boolean);
  action: ActionName;
  params?: ActionParams;
  reason?: string;
}
```

Every field in a `MatchSpec` must match — it is an `AND`. Fields accepting a list match if
*any* entry matches. An empty `match: {}` matches everything, which is occasionally what
you want at the bottom of a list.

## What this request is

| Field | Type | |
| ----- | ---- | --- |
| `verdict` | one or more [`Verdict`](../concepts/verdicts.md) | `"suspected-bot"`, `["confirmed-bot", "verified-bot"]` |
| `botClass` | one or more `BotClass` | The field most policies want — it carries intent. |
| `certain` | `boolean` | `true` matches only proven verdicts, including a proven human. |
| `minScore` / `maxScore` | `number` | Inclusive. Only meaningful for probabilistic verdicts. |

```ts
// Proven automation of any kind
{ match: { certain: true, verdict: ["confirmed-bot", "verified-bot"] } }

// A judgement, but a confident one
{ match: { verdict: "suspected-bot", minScore: 70 } }
```

## Who this claims to be

| Field | Type | |
| ----- | ---- | --- |
| `identity` | one or more `string` | A [signature](../detection/signatures.md) id: `"googlebot"`, `"gptbot"`. |
| `category` | one or more `BotCategory` | `"ai"`, `"search"`, `"seo"`, `"scanner"`, … |

```ts
{ id: "no-training", match: { category: "ai" }, action: "block" }
```

**An identity match alone matches forgeries too**, because the identity is what the client
*claimed*. Pair it with `verdict: "verified-bot"` when trust is the point:

```ts
{ id: "trust-google", match: { identity: ["googlebot"], verdict: "verified-bot" }, action: "allow" }
```

## What it asked for

| Field | Type | |
| ----- | ---- | --- |
| `path` | `string \| RegExp` or a list | A string matches as a **prefix**; a regex is tested as written. |
| `method` | one or more `string` | Upper-case. |

```ts
{ id: "protect-export", match: { path: ["/api/export", "/reports/"], verdict: "suspected-bot" },
  action: "challenge" }
```

## What fired

| Field | Type | |
| ----- | ---- | --- |
| `detector` | one or more `string` | Matches if **any** evidence came from one of these. |

```ts
// Traps are proof. Nothing else needs to be true.
{ id: "trapped", match: { detector: ["trap"], certain: true }, action: "block" }
```

## What this actor has done before

| Field | Type | |
| ----- | ---- | --- |
| `minPriorConfirmations` | `number` | Times this actor was **proven** a bot before now. |
| `minUnsolvedChallenges` | `number` | Challenges issued that no solution came back for. |

```ts
{ id: "repeat-offender", match: { minPriorConfirmations: 3 }, action: "block",
  reason: "Proven automation three times from this actor." }

{ id: "persistent-refusers", match: { minUnsolvedChallenges: 3 }, action: "rate-limit" }
```

`minUnsolvedChallenges` is **outstanding rather than cumulative**: solving one clears the
count, so it never accumulates against somebody who came back and proved it. It is a rule
rather than evidence on purpose — one abandoned challenge is a person having a moment, and
what repetition means depends on traffic the library cannot see. See
[actors](../concepts/actors.md).

## A predicate, for anything else

```ts
{
  id: "checkout-under-attack",
  match: (assessment) =>
    assessment.facts.path.startsWith("/checkout") &&
    assessment.score > 50 &&
    assessment.actor.requests > 20,
  action: "challenge",
}
```

Two things to know. A predicate that **throws** is skipped rather than matched — "unknown"
cannot safely mean "yes". And a predicate cannot be serialised, so a rule using one is
shown read-only in the dashboard's editor and spliced back at its original index on save:
order is the whole semantics, so "wherever it ends up" is not an option.

## Validation

`validateRules` runs at construction and reports what is survivable rather than throwing:
duplicate ids, a rule shadowed by a broader one above it, an action whose parameters are
missing. Warnings go to `onWarning` and to the dashboard's notices.

```ts
import { validateRules } from "bothandlerjs";
validateRules(myRules);   // string[] — empty is good
```

## Related

- [Actions](actions.md) — what a matched rule can ask for
- [The safety guard](../concepts/the-guard.md) — what it is allowed to get
- [Verdicts, classes and scores](../concepts/verdicts.md) — the vocabularies above
