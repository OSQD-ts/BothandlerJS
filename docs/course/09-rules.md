# Lesson 9 — Rules

**Goal:** write the policy you designed in lesson 3, and understand why order decides
everything.

← [Course](index.md) · Prev: [Traps](08-traps.md) · Next: [Actions and presets](10-actions-and-presets.md)

---

## The shape

```js
{
  id: "scraper-ratelimit",              // required, and it appears in every decision
  match: { botClass: "scraper" },       // every field present must match
  action: "rate-limit",
  params: { limit: { max: 60, windowMs: 60_000 } },
  reason: "Bulk extraction. Rate-limited rather than refused.",
}
```

**First match wins.** Rules are evaluated in order and the first that matches decides;
nothing accumulates. If none matches, `defaultAction` applies — `allow` unless you change
it.

**`id` is not decoration.** It comes back in `decision.rule`, in the dashboard, in every
downgrade event and in the replay report. Name rules after what they do, not after what
they match.

**`reason` is read by people.** It appears in the dashboard and in `bothandlerjs replay`
output. Write it for whoever is looking at a refused request at 2am.

## Every field you can match on

Grouped by the question each answers.

**What did we conclude?**

| Field | |
| ----- | - |
| `verdict` | one or several of `confirmed-bot`, `verified-bot`, `suspected-bot`, `human`, `unknown` |
| `certain` | `true` to require proof |
| `botClass` | one or several classes |
| `minScore` / `maxScore` | inclusive score band |

**Who is it?**

| Field | |
| ----- | - |
| `identity` | a named signature — `"gptbot"`, `"googlebot"` |
| `category` | `ai`, `search`, `seo`, `social`, `monitoring`, `feed`, `archive`, `security`, `library`, `headless`, `advertising` |
| `detector` | fired by a named detector — `"trap"`, `"probe-signature"` |

**What did they do?**

| Field | |
| ----- | - |
| `path` | string prefix, `RegExp`, or a list of either |
| `method` | `"POST"`, or a list |

**What have they done before?**

| Field | |
| ----- | - |
| `minPriorConfirmations` | proven a bot this many times in the window |
| `minUnsolvedChallenges` | issued this many challenges and finished none |

Every field present must match. An empty `match: {}` matches everything, which is how you
write a catch-all last rule.

## Do this: Serif's policy

Take the table from [lesson 3](03-verdicts-and-scores.md) and write it out.

```js
import { BotHandler, createFacts } from "@osqd/bothandlerjs";

const detector = new BotHandler({
  rules: [
    { id: "verified-crawler-allow", match: { verdict: "verified-bot" }, action: "allow",
      reason: "Confirmed search or social crawler — the traffic Serif wants." },

    { id: "impersonator-block", match: { botClass: "impersonator", certain: true }, action: "block",
      reason: "Forged a verifiable crawler identity. Proven by DNS, not inferred." },

    { id: "scanner-block", match: { botClass: "scanner", certain: true }, action: "block",
      reason: "Self-identified security scanner." },

    { id: "trap-block", match: { detector: "trap", certain: true }, action: "block",
      reason: "Followed a link no person can reach." },

    { id: "scraper-ratelimit", match: { botClass: "scraper" }, action: "rate-limit",
      params: { limit: { max: 60, windowMs: 60_000 } },
      reason: "Behaves like bulk extraction. Slowed rather than refused." },

    { id: "http-client-challenge", match: { botClass: "http-client" }, action: "challenge",
      reason: "Bare HTTP client. Challenged rather than blocked: it may be somebody's integration." },

    { id: "declared-bot-tag", match: { botClass: "declared-bot" }, action: "tag",
      reason: "Announced itself honestly. Tagged so the application can decide." },

    { id: "suspected-tag", match: { verdict: "suspected-bot" }, action: "tag",
      reason: "Some signal, not enough to act on." },
  ],
});
```

Run the lesson 3 cases through `decide` and check each lands on the rule you intended.

## Order is the policy

Move `suspected-tag` to the top and every rule below it stops mattering for anything
suspected — including your scanner block, because a scanner is also suspected. Nothing
warns you; the policy simply does less than it reads.

Two habits that prevent it:

**Allows for traffic you want, first.** A verified crawler should be decided before
anything gets a chance to be clever about it.

**Specific before general.** `{ botClass: "scanner" }` before `{ verdict: "suspected-bot" }`,
always.

## Your own rules run before a preset's

```js
new BotHandler({
  preset: "protect-content",
  rules: [{ id: "partner-allow", match: { path: "/api/partner" }, action: "allow" }],
});
```

`rules` are evaluated **before** the preset's, which makes this the clean way to add
exceptions without copying a preset. [Lesson 10](10-actions-and-presets.md) covers when to
adopt a preset wholesale instead.

## Predicates, and what they cost

When the declarative fields cannot say it, `match` takes a function:

```js
{
  id: "checkout-under-attack",
  match: (assessment, facts) => facts.path.startsWith("/checkout") && assessment.score > 50 && !assessment.certain,
  action: "delay",
  params: { delayMs: 500 },
}
```

Two things it costs you.

**`robotsFromRules` cannot read it.** A predicate can be run but not asked which crawlers
it is about, so it is reported as `unreadable` rather than guessed at — see
[lesson 10](10-actions-and-presets.md).

**The dashboard cannot preview it usefully.** A declarative match can be explained; a
function can only be executed.

Reach for one when you need it, and prefer the fields when you do not.

## Validate before you ship

```js
import { validateRules } from "@osqd/bothandlerjs";
const problems = validateRules(myRules);
if (problems.length > 0) throw new Error(problems.join("\n"));
```

It catches duplicate ids, unknown actions, a `redirect` with no `location`, a `custom` with
no registered handler, and score bands that can never match. `new BotHandler()` runs it for
you and reports through `onWarning`; calling it yourself turns a warning into a failing
test.

## Exercise

Add two rules to Serif and place them correctly:

1. `/checkout` should never be served to anything proven automated.
2. A client that has been issued five challenges and finished none should be blocked.

<details>
<summary>Answer</summary>

```js
rules: [
  { id: "verified-crawler-allow", match: { verdict: "verified-bot" }, action: "allow" },

  // Before the generic blocks: it is more specific, and it is about a path.
  { id: "checkout-no-bots", match: { path: "/checkout", certain: true, botClass: ["http-client", "automation", "scanner", "impersonator", "declared-bot"] },
    action: "block", reason: "Proven automation on the checkout." },

  { id: "persistent-refusal", match: { minUnsolvedChallenges: 5 }, action: "block",
    reason: "Issued five challenges, finished none." },

  // …the rest as before
]
```

Two things to notice.

**`checkout-no-bots` lists classes rather than using bare `certain: true`** — which would
also match a proven *human*, and blocking a customer you just vouched for on your own
checkout is the worst possible outcome. This is the trap from lesson 3, in the place it
does most damage.

**`persistent-refusal` is a rule, not evidence.** One abandoned challenge is a person. What
five of them mean is a judgement about your traffic, so the library exposes the count and
lets you decide rather than deciding for you.
</details>

## What you learned

- First match wins; order is the policy and nothing warns you when it is wrong
- `id` and `reason` are read by people and by tools — write them properly
- Twelve declarative fields, grouped by the question they answer
- Your `rules` run before a preset's, which is how to add exceptions cleanly
- A predicate costs you `robots.txt` generation and dashboard preview

## Reference

- [Matching requests](../policy/rules.md) — every field in detail
- [Policy overview](../policy/index.md) — how a decision is reached

Next: [Actions and presets](10-actions-and-presets.md).
