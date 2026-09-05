# Verdicts, classes and scores

What the engine concludes, and which field you should actually be reading.

← [Documentation](../index.md)

---

An assessment carries three different summaries of the same request. They answer
different questions and are not interchangeable.

## `verdict` — what this is

```ts
type Verdict = "confirmed-bot" | "verified-bot" | "suspected-bot" | "human" | "unknown";
```

| Verdict | Proven? | Means |
| ------- | ------- | ----- |
| `confirmed-bot` | yes | Proven automation. It said so, walked into a trap, or violated a protocol. |
| `verified-bot` | yes | Proven automation **and** proven to be who it claims — a crawler that checked out. |
| `suspected-bot` | no | The score crossed `suspectThreshold`. A judgement call. |
| `human` | no | Human evidence outweighs bot evidence. Also a judgement. |
| `unknown` | no | Nothing conclusive either way. **This is what ordinary traffic looks like.** |

`unknown` being the common case is not a failure. Most requests carry no strong signal in
either direction, and a library that concluded something about all of them would be
guessing about most of them.

## `certain` — whether it is proven

```ts
if (assessment.certain) { /* there is at least one `certain` piece of evidence */ }
```

**This is the field to read**, not the score. `certain` is what the
[guard](the-guard.md) consults before allowing a terminal action, and it is the only
thing that distinguishes "we know" from "we think".

A proven **human** sets `certain` too — an operator assertion or a granted clearance is
proof in the same sense. Check `verdict` alongside it when the direction matters.

## `score` — how suspicious, when it is a judgement

An integer. `0–99` for a probabilistic verdict; a flat `100` for anything proven, for the
benefit of dashboards that chart one.

The score exists to be *compared*, not to be trusted absolutely. It is the output of a
saturating function over weighted evidence, so the difference between 40 and 60 is real
and the difference between 96 and 98 is noise.

```ts
suspectThreshold: 60   // the score at which a verdict becomes `suspected-bot`
```

Before you move that number, look at the score distribution on the
[dashboard](../operations/dashboard.md) or in `bothandler_score_bucket`: the question is
not "is 60 right in the abstract" but "how close does *my* ordinary traffic run to it".

## `botClass` — what kind of thing this is

```ts
type BotClass =
  | "human" | "verified-bot" | "declared-bot" | "automation"
  | "http-client" | "scanner" | "scraper" | "impersonator" | "unknown";
```

This is the field policies usually want, because it carries intent in a way a verdict
does not. `verified-bot` and `impersonator` are both proven; one is Googlebot and the
other is something pretending to be it.

| Class | Typical example |
| ----- | --------------- |
| `verified-bot` | Googlebot, confirmed by reverse DNS or a published range |
| `declared-bot` | GPTBot, ClaudeBot — honest, unverified, and a business decision |
| `http-client` | curl, python-requests, Go-http-client |
| `automation` | Headless Chrome, Playwright, Selenium |
| `scraper` | Behaviourally a scraper: breadth, cadence, no session |
| `scanner` | sqlmap, Nikto, probes for `/wp-admin` and `.env` |
| `impersonator` | Claimed an identity that was refuted |
| `human` | Proven or strongly indicated to be a person |

## `confidence`

`0–1`, the raw probability before the threshold is applied. Useful if you are charting
distributions or building your own thresholds; `score` is the same number scaled and
rounded.

## Putting it together

```ts
const { assessment, decision } = await detector.handle(facts);

// The two questions worth asking, in this order:
if (assessment.certain && assessment.botClass === "impersonator") {
  // Proven forgery. Safe to refuse.
}
if (assessment.verdict === "suspected-bot") {
  // A judgement. Challenge, tag, slow — never refuse on this alone,
  // and the guard will stop you if a rule tries.
}
```

## Related

- [Evidence and certainty](evidence.md) — where all of this comes from
- [The safety guard](the-guard.md) — why `certain` matters more than `score`
- [Matching requests](../policy/rules.md) — matching rules on any of these fields
