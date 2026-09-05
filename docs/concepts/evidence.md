# Evidence and certainty

The distinction the whole library rests on: **proof versus suspicion**.

← [Documentation](../index.md)

---

Every detector produces *evidence*, never a verdict. A piece of evidence carries a
`certainty` tier, and there are two kinds of tier with two different sets of rules.

| Tier | Weight | What it means |
| ---- | ------ | ------------- |
| `certain` | — | **Proof.** There is no benign explanation, and the detector has to write down why. |
| `strong` | 0.60 | A signal with a real population of exceptions. |
| `moderate` | 0.35 | Suggestive. |
| `weak` | 0.15 | Worth a point, not worth a sentence. |

`certain` is not "very strong". It is a different kind of claim, and it is the only kind
that can cost somebody their access.

## What makes something certain

A `certain` piece of evidence must carry a `deterministicBasis` — a written explanation
of why no legitimate client produces this. Not "no legitimate client we know of": none,
by construction.

```ts
{
  detector: "self-identified",
  certainty: "certain",
  summary: 'User-Agent identifies curl',
  deterministicBasis:
    'The product token "curl/" is emitted by an HTTP library or an automation ' +
    "runtime and by no browser. Nothing a person does in a browser produces it.",
}
```

There are only a few genuine sources of proof, and they are all of the same shape —
**the client told us, or the client did something only automation does**:

- **A self-declaration.** `python-requests/2.31.0` in a User-Agent is not an inference.
  If it is a lie, the misclassification belongs to whoever lied.
- **A refuted identity.** Something claimed to be Googlebot; the operator's own DNS says
  the address is not Google's. The claim is disproven by the party entitled to answer.
- **A trap.** A path no link points at, a form field no rendered browser displays.
  Reaching it requires reading the page as data rather than as a page.
- **A protocol violation.** Two `Host` headers. `Connection: keep-alive` on HTTP/2.
  Something a compliant client cannot emit.
- **An operator assertion.** Your code said this is a person. We believe you.

Everything else is a judgement. A missing `Accept-Language` is *suspicious* and belongs
to a real population: privacy browsers, corporate proxies, screen readers, old phones.

## How the two tiers combine

Differently, on purpose.

**Proof does not accumulate.** One `certain` piece is enough, and a second adds nothing:
the verdict is already `confirmed-bot` or `verified-bot`, the score is reported as 100
for anything that charts one, and no amount of probabilistic evidence can produce the
same outcome. Certainty short-circuits scoring entirely.

**Suspicion accumulates by noisy-OR**, not by addition:

```
pBot = 1 − Π (1 − weight)
```

Three `moderate` signals reach 0.72, not 1.05. The function saturates, which is the
point: adding a fourth weak signal to three strong ones should barely move a number that
is already near certainty, and adding twenty weak ones must never *reach* it.

```ts
import { combineEvidence, noisyOr } from "bothandlerjs";

noisyOr([0.6, 0.35, 0.35]);   // 0.831 — not 1.3
```

### Families

Signals that are one signal wearing different hats are counted once. A client missing
`Accept-Language`, `Accept-Encoding` and `Referer` has one property — it is not a
browser — reported three times, and letting each contribute independently would triple a
single observation.

```ts
{ detector: "header-integrity", family: "absent-browser-headers", certainty: "moderate" }
```

Within a family only the strongest counts. It is a scoring correction and nothing more:
families never touch the proven path.

### Human evidence subtracts

Almost every detector argues in one direction, which is a problem the scoring model has
to make visible. A person reading forty pages of documentation from a university's shared
address accumulates `rate-anomaly`, `cadence`, `crawl-breadth` and `ip-intelligence`
without a single thing being wrong with their request.

So evidence has a `direction`, and the engine discounts the bot score by whatever human
evidence it holds:

```
score = pBot × (1 − pHuman)
```

[`browsing-coherence`](../detection/detectors.md#browsing-coherence) exists entirely to
produce that counterweight — a cache validator, a cookie jar, a same-site navigation are
the marks of a browsing session, and a scraper has none of them.

## Reading it back

```ts
const assessment = await detector.assess(facts);

assessment.certain;        // true ← this, not the score, gates terminal actions
assessment.verdict;        // "confirmed-bot"
assessment.score;          // 100 for proven; 0–99 for a judgement
assessment.evidence;       // strongest first
assessment.humanEvidence;  // what argued the other way
assessment.evidence[0].deterministicBasis;   // why it cannot be wrong
```

`strictEvidence` (on by default) makes the rule mechanical rather than cultural: a
detector returning `certain` with no `deterministicBasis` is rejected and reported
through `onWarning`. See [Writing a detector](../detection/writing-a-detector.md).

## Related

- [Verdicts, classes and scores](verdicts.md) — what the engine does with all this
- [The safety guard](the-guard.md) — what stops a score from denying anybody
- [The detectors](../detection/detectors.md) — which tier each one can reach
