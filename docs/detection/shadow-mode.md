# Shadow mode

Run a detector on every request and let it decide nothing. Then read what it would have
done, from your own traffic, before it does it.

← [Documentation](../index.md) · [Detection](index.md)

---

## The problem it solves

Every detector ships with thresholds somebody chose. They were chosen against a corpus of
real traffic and they are defensible — and they were not chosen against *your* traffic,
which is the only traffic that matters when the question is whether a threshold is about
to start challenging your customers.

The [correlation detectors](correlation.md) make this sharp, because several of them fire
at `moderate` on real people **by design**:

- a phone moving between wifi and cellular presents one marker from many networks, which
  is what `marker-fanout` counts;
- a crowd arriving on a link somebody posted wrong all request the same missing page,
  which is what `path-campaign` counts;
- tapping "Request desktop site" changes the platform a client claims, which is what
  `identity-drift` counts.

None of those is a bug. Each is a real observation with a real innocent explanation, and
whether the threshold separating them is right *here* is not a thing this library can
know. Shadow mode is how you find out without anybody being turned away while you do.

```js
const handler = new BotHandler({
  preset: "protect-content",
  site: {},
  probe: { secrets: [process.env.MARKER_SECRET] },
  shadowDetectors: ["path-novelty", "marker-fanout", "path-campaign"],
});
```

Those three now run on every request exactly as they otherwise would. Their findings are
counted, charted, and readable in the dashboard next to the evidence that did decide.
And they decided nothing.

## What "decided nothing" means, precisely

A shadowed detector cannot affect:

| | |
| --- | --- |
| the verdict | including via `certain` evidence, which does not go through scoring at all |
| the score and the confidence | its findings are not in the arithmetic |
| the bot class and the identity | the class is picked from evidence that counted |
| any rule | a rule matching `detector: "path-novelty"` does not match a shadowed one |
| anything downstream of a verdict | the guard, the action, the challenge, `recordOutcome` |

This is not a weight of zero, and the difference is the whole design. A weight is
consulted on the **probabilistic** path; `certain` evidence never reaches that path,
because it short-circuits scoring and returns `confirmed-bot` on its own — which is what
makes a terminal action permissible. A shadowed detector emitting `certain` would have
blocked people with its weight sitting at zero the entire time.

So the evidence is kept out of the arithmetic rather than weighted inside it. It lands in
`assessment.shadowEvidence`, which nothing that decides anything reads:

```js
const assessment = await handler.assess(facts);

assessment.evidence;        // what decided this request
assessment.shadowEvidence;  // what the shadowed detectors said, flagged with `shadow: true`
assessment.shadowVerdict;   // what the verdict would have been if they had counted
```

## The number that actually answers the question

`shadowVerdict` is the point. "It fired 312 times" is not a thing anybody can act on; what
you need to know is what turning it on would *do*, and the honest form of that is the
verdict each request would have received.

It is computed only when a shadowed detector found something, so a well-behaved one costs
nothing on the requests it is silent about — and a badly-behaved one is the case you
wanted to hear about anyway.

```js
if (assessment.shadowVerdict?.verdict !== assessment.verdict) {
  log.info({ was: assessment.verdict, wouldBe: assessment.shadowVerdict?.verdict }, "shadow");
}
```

## Reading it

**In the dashboard.** Shadowed findings appear in the evidence list for each request,
dimmed and labelled *"shadowed: counted, and part of no decision"*, with a line beneath
saying what the verdict would have been. The Statistics tab counts them separately from
real firings and reports how many verdicts they would have moved, by the verdict they
would have produced.

**In Prometheus**, only when something is shadowed:

```
bothandler_shadow_firings_total{detector="path-novelty"} 312
bothandler_shadow_verdict_changes_total{verdict="suspected-bot"} 41
```

Forty-one against a `human` count that did not move is the shape of a detector about to
start challenging people. That is the reading this exists to make possible.

**In `detectors()`**, a shadowed detector is marked, so `describeDetectors()` and the
dashboard's detector list both say so even before it has fired once.

## How to use it

1. Turn a detector on in shadow, alongside the policy you are already running.
2. Leave it a week. A week, not a day: the traffic that catches a threshold out is the
   Monday morning, the campaign, the outage, the release.
3. Read `shadow_verdict_changes_total`. If it would have moved requests to
   `suspected-bot` or `confirmed-bot`, find them in the dashboard and read them — one at
   a time, as requests, not as a number.
4. Either adjust the threshold and go back to step 2, or take it out of
   `shadowDetectors`.

This is the same shape as [`monitor-only`](../policy/presets.md#monitor-only) and
[`replay`](../testing/replay.md), and it answers the question those two cannot: *what
happens when I add something new to a policy that is already running*.

## The honest limits

**A shadowed detector still consumes its budget.** It runs, it is timed, and if it throws
or times out that is recorded like any other failure. Shadowing is about influence, not
about cost.

**It still writes to actor state, if it writes to actor state.** Detectors are supposed to
report rather than record — the recording that matters happens in the pipeline around them
— but a custom detector that mutates `ctx.state` in `inspect` will do so shadowed or not.
The bundled ones do not.

**Naming a detector that is not installed is a warning, not an error.** The usual cause is
a typo, and a typo here is otherwise invisible: nothing was going to run, so nothing looks
any different either way. The warning is checked after the handler has finished installing
detectors, because the marker, site and challenge detectors arrive with the source they
read — and those are exactly the ones worth shadowing.

## Related

- [The detectors](detectors.md) — what each one reads, and its ceiling
- [Correlation](correlation.md) — the sources whose thresholds this exists to check
- [Metrics](../operations/metrics.md) — the counters, in full
- [Choosing a policy](../start/choosing-a-policy.md) — the same caution, one level up
