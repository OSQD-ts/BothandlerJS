# Choosing a policy

The decision, start to finish.

← [Documentation](../index.md) · [Getting started](../index.md)

---

## Start with the question, not the preset

Not "how do I block bots" but: **what is this site for, and what would it cost me to be
wrong?**

| If being wrong about a *person* costs you… | and being wrong about a *bot* costs you… | start with |
| --- | --- | --- |
| a reader | some bandwidth | [`allow-crawlers`](../policy/presets.md#allow-crawlers) |
| a customer | your content, scraped | [`protect-content`](../policy/presets.md#protect-content) |
| a customer | your pricing, in a competitor's spreadsheet | [`protect-data`](../policy/presets.md#protect-data) |
| a broken integration | an API bill | [`protect-api`](../policy/presets.md#protect-api) |
| a lost signup | a compromised account | [`protect-auth`](../policy/presets.md#protect-auth), on those routes |
| your search traffic | your work in a training corpus | [`decline-ai-training`](../policy/presets.md#decline-ai-training) |
| a reader in an in-app browser, and your own health checks | any automation you did not confirm by name | [`indexers-only`](../policy/presets.md#indexers-only) |

Whatever the answer, **the first week is [`monitor-only`](../policy/presets.md#monitor-only)**.

## The four questions worth answering explicitly

### 1. Which crawlers do you actually want?

This is a business decision, not a security one, and it deserves to be a visible rule you
can point at rather than a threshold somebody tuned.

Search and social crawlers bring readers. AI training crawlers take work and return nothing
you can measure. SEO crawlers serve your competitors. Feed readers and link unfurlers are
somebody's actual reading habit.

If you decline any of them, **say so in [`robots.txt`](../policy/robots.md)** — the ones
worth declining honour it, and a rule that blocks a crawler nobody told is load with no
compliance.

### 2. What happens to suspicion?

The [guard](../concepts/the-guard.md) settles the top of the range: unproven never means
denied. Below that, you choose between `tag`, `delay`, `rate-limit` and `challenge`, and the
right answer depends on who your unusual visitors are.

A `challenge` needs a browser. On an API it breaks your customers' integrations and stops
nobody, which is why [`protect-api`](../policy/presets.md#protect-api) uses rate limits
instead. A `delay` excludes nobody at all and is the quiet choice on a form.

Look at [`bothandler_score_bucket`](../operations/metrics.md) before you move a threshold. It
tells you how many requests sit in the ten points you are about to cross.

### 3. Where does the policy *not* apply?

`ignorePaths` for health checks and static assets. `allowlist` for your monitors, your
office and your CI — and remember that an allowlisted address is not judged leniently, it is
not judged at all.

And the routes that need a *different* policy get their own handler:

```ts
app.use(botHandler(siteDetector));
app.use("/login",    botHandler(authDetector));
app.use("/checkout", botHandler(authDetector));
```

### 4. Who is allowed to change it, and how fast?

An incident is when you will want to change a rule without a deploy. Decide now whether
[the dashboard's editor](../operations/runtime-changes.md) is enabled, who can reach it, and
whether the [guard panel](../concepts/the-guard.md) is enabled separately — it is a different
power with different consequences.

---

## Check it before it meets anybody

```bash
npx @osqd/bothandlerjs check --preset protect-content --audience human
npx @osqd/bothandlerjs replay /var/log/nginx/access.log --preset protect-content
```

The first is [526 shapes of real traffic](../testing/corpus.md); the second is *yours*. Both
print every request the policy would have refused, with the evidence.

For your own configuration rather than a preset:

```ts
import { runCorpus } from "@osqd/bothandlerjs/corpus";
const scorecard = await runCorpus({
  create: ({ resolver, clock }) => new BotHandler({ ...myConfig, resolver, clock }),
  assertActions: false,
});
if (scorecard.falsePositives.length > 0) throw new Error("this policy turns people away");
```

## Owning it rather than naming it

A preset is an array of [rules](../policy/rules.md). Once you have changed one thing, take
the whole set:

```ts
import { protectContent } from "@osqd/bothandlerjs";

const rules = protectContent()
  .filter((rule) => rule.id !== "http-client-challenge")   // our partners use curl
  .concat({ id: "partner-allow", match: { path: "/api/partner" }, action: "allow" });
```

Your own rules are evaluated **before** a preset's, so `rules` plus `preset` is a valid way
to prepend exceptions without copying anything.

## What to watch once it is live

| Signal | Means |
| ------ | ----- |
| `bothandler_downgrades_total` rising | your rules ask for more than the evidence supports |
| `challenge-solve-rate` high | the challenges are taxing people, not filtering bots |
| `verdicts_total{verdict="unknown"}` falling | your traffic changed, or your detection did |
| a `denial-spike` anomaly | read the denials before assuming they are all bots |

## Next

- [Presets](../policy/presets.md) — all eight, in detail
- [Rules](../policy/rules.md) — the grammar
- [Actions](../policy/actions.md) — ordered by what each costs a person
- [Threat model](../concepts/threat-model.md) — what none of this can do
