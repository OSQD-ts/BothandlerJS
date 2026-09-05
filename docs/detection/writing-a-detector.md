# Writing a detector

The contract, and the one rule you cannot bend.

← [Documentation](../index.md) · [The detectors](detectors.md)

---

A detector returns **evidence** and never a verdict. It does not know what will be done
with what it found, and that is deliberate: the same observation is worth a tag on a
documentation site and a challenge on a checkout.

```ts
import type { Detector, Evidence } from "@osqd/bothandlerjs";

export function checkoutVelocity(): Detector {
  return {
    id: "checkout-velocity",
    description: "More checkout attempts in a minute than a person makes",
    cost: "cheap",
    stage: "always",

    inspect(ctx): Evidence | undefined {
      if (!ctx.facts.path.startsWith("/checkout")) return undefined;

      const attempts = ctx.state.requestsWithin(60_000, ctx.facts.timestamp);
      if (attempts < 8) return undefined;

      return {
        detector: "checkout-velocity",
        summary: `${attempts} checkout attempts in a minute`,
        direction: "bot",
        certainty: "strong",   // not `certain` — a shared address explains it too
        weight: 0.6,
        botClass: "automation",
      };
    },
  };
}

new BotHandler({ extraDetectors: [checkoutVelocity()] });
```

## The context

```ts
interface DetectionContext {
  facts: RequestFacts;          // the normalised request
  ua: ParsedUserAgent;          // parsed once, shared by every detector
  actor: ActorSnapshot;         // history *before* this request
  state: ActorState;            // the live object: requestsWithin, intervalStats, …
  clock: Clock;
  signatures: MultiPatternMatcher;
  signatureMatches: BotSignature[];
  resolver: DnsResolver;
  ranges: Map<string, IpRangeSet>;
  shared: Map<string, unknown>;  // scratch space for one request
}
```

`shared` exists so two detectors can avoid doing the same expensive thing twice within a
single assessment. It is discarded afterwards.

## The rule about certainty

**`certain` requires a written `deterministicBasis`.** Not a strong feeling — an
explanation of why no legitimate client produces this:

```ts
{
  certainty: "certain",
  deterministicBasis:
    "HTTP/2 forbids connection-specific headers outright. A compliant client cannot " +
    "send one, so its presence is a protocol violation rather than an unusual choice.",
}
```

`strictEvidence` (on by default) enforces it: evidence marked `certain` with no basis is
**rejected** and reported through `onWarning`. The mechanism is there because "is this
really proof?" is a question people answer optimistically at 2am, and a downgrade is a
much better failure than a false accusation.

If you are unsure, you want `strong`. A `strong` signal still tags, delays, rate-limits
and challenges; the only thing it cannot do is deny somebody service, and if you cannot
write the sentence then it should not be able to.

## Cost and stage

| | |
| --- | --- |
| `cost: "cheap"` | Synchronous, in-memory. Run without an await. |
| `cost: "io"` | May touch the network or a store. Run concurrently under a timeout. |
| `stage: "always"` | Every request. |
| `stage: "confirming"` | Only when a signature matched — there is a claim to check. |

Mislabelling an `io` detector as `cheap` would put an unbounded await on the request path.
The engine times out any promise a `cheap` detector returns anyway, so the failure mode is
a timeout rather than a hung request — but label it correctly.

## Human-pointing evidence

`direction: "human"` puts the evidence on the other side of the scale, where it
*discounts* suspicion. Use it for positive marks of a real session, and hold it to the
same standard: a `certain` human signal means somebody's own code asserted it, not that a
cookie looked plausible.

## Families

If your detector fires on the same root cause as another, declare a `family`. Within a
family the engine takes the strongest observation rather than compounding them — see
[families](../concepts/evidence.md#families).

## Replacing a shipped detector

`defaultDetectors()` returns the standard set as an array, so swapping one for a
configured version is a `map`:

```ts
import { defaultDetectors, probeSignatureDetector } from "@osqd/bothandlerjs";

new BotHandler({
  detectors: defaultDetectors().map((d) =>
    d.id === "probe-signature" ? probeSignatureDetector({ ignore: ["/wp-login.php"] }) : d,
  ),
});
```

## Testing it

Put your handler in front of the [corpus](../testing/corpus.md). A new detector that
scores an extra ten points on every headless browser is doing its job; one that also
scores three points on every Safari user is not, and only the corpus will tell you which
you wrote.

```ts
import { runCorpus } from "@osqd/bothandlerjs/corpus";

const scorecard = await runCorpus({
  create: ({ resolver, clock }) => new BotHandler({ extraDetectors: [mine()], resolver, clock }),
  assertActions: false,
});
expect(scorecard.falsePositives).toEqual([]);
```

See `examples/custom-detector.ts` for a complete one.
