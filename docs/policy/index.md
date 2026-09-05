# Policy

How an assessment becomes a decision.

← [Documentation](../index.md)

---

The engine's two halves are deliberately separate. `assess` says what a request *is*;
policy says what to *do* about it. Nothing in detection knows about actions, and nothing
in policy re-examines a request.

```ts
const assessment = await detector.assess(facts);   // detection
const decision = detector.decide(assessment);      // policy — pure, no state, no I/O
```

`decide` being pure is what makes the [replay](../testing/replay.md), the
[corpus](../testing/corpus.md) and the dashboard's policy preview possible: a candidate
policy can be run over recorded assessments as many times as you like, and nothing about
the running system moves.

## Rules, in order

```ts
new BotHandler({
  rules: [
    { id: "allow-verified", match: { verdict: "verified-bot" }, action: "allow" },
    { id: "no-ai",          match: { category: "ai" },          action: "block" },
    { id: "slow-scrapers",  match: { botClass: "scraper" },     action: "rate-limit",
      params: { limit: { max: 60, windowMs: 60_000 } } },
  ],
  defaultAction: "allow",
});
```

**First match wins.** Order is the whole semantics — a broad rule above a narrow one makes
the narrow one dead configuration, which is why the dashboard lists rule hit counts
*including the zeros* and why the rules in the editor are numbered and movable.

If nothing matches, `defaultAction` applies (default `allow`). Every decision names the
rule that produced it, including that one:

```ts
{
  action: "challenge",
  rule: "suspected-challenge",
  reason: "Several probabilistic signals agree. A challenge the client can pass on its own.",
  params: {},
}
```

## Then the guard

Between the rule and the decision sits [the safety guard](../concepts/the-guard.md), which
refuses to let a terminal action rest on a guess. This is the mechanism the library is
built around and it is worth reading that page before writing rules that block anything.

A stopped decision carries what it was:

```ts
{ action: "challenge", downgradedFrom: "block", downgradeReason: "Strict mode permits …" }
```

## Reasons are part of the rule

```ts
{ id: "no-ai", match: { category: "ai" }, action: "block",
  reason: "Not for model training. mailto:licensing@example.com" }
```

`reason` appears in the decision, in your logs, on the dashboard, and — for a `block` —
can be served to the client. A refusal that explains itself and names a way to ask is the
difference between a policy and a wall. Somebody on the other end is often a person.

## Where to go next

| | |
| --- | --- |
| [Matching requests](rules.md) | Every field a rule can match on. |
| [Actions](actions.md) | All ten, ordered by what each costs a person. |
| [Presets](presets.md) | Eight shipped policies; start from one. |
| [robots.txt](robots.md) | The file your policy implies. |
| [Runtime changes](../operations/runtime-changes.md) | Replacing rules without a deploy. |
