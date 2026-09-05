# Lesson 6 — Identity and verification

**Goal:** recognise a crawler by name, then prove or refute the claim — and understand why
a name alone is worth so little.

← [Course](index.md) · Prev: [The detectors](05-detectors.md) · Next: [Actors and behaviour](07-actors.md)

---

## A name is a claim, not a fact

`self-identified` matches 161 signatures across search, AI, SEO, social, monitoring,
feeds, archives, security tooling, HTTP libraries and headless runtimes. When it fires you
get an `identity` — `"googlebot"`, `"gptbot"` — and a `category`.

For a client that has nothing to gain by lying, that is enough: `curl` saying it is `curl`
is proof, because no honest client is harmed by being believed.

**But `Googlebot` is worth impersonating.** A name that buys privileged treatment cannot be
taken on trust, which is what verification is for.

## Do this

```js
const forged = await detector.assess(
  createFacts({
    method: "GET", url: "/", ip: "203.0.113.200",
    headers: { host: "serif.example", "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  }),
);

console.log(`verdict=${forged.verdict} class=${forged.botClass} identity=${forged.identity} certain=${forged.certain}`);
for (const e of forged.evidence) console.log(`  [${e.certainty}] ${e.detector}: ${e.summary}`);
```

> This one makes a real DNS lookup. It is the only example in the course that touches the
> network.

### Checkpoint

```
verdict=confirmed-bot class=impersonator identity=googlebot certain=true
  [certain] self-identified: User-Agent identifies Googlebot
  [certain] crawler-verification: Client claims to be Googlebot, but DNS refutes it:
            address has no PTR record, which every operator of a verifiable crawler publishes
```

Two pieces of proof, pointing in opposite directions about the same client — it *is*
declared automation, and it is *not* what it declared. The class is `impersonator`, and
that is a verdict you can act on with confidence, because it rests on an external authority
rather than on a pattern.

## How forward-confirmed reverse DNS works

Three steps, and the third is the one people skip:

1. **Reverse.** Look up the `PTR` record for the client's address → `crawl-66-249-66-1.googlebot.com`
2. **Check the domain.** Does it end in a domain the operator publishes? → `googlebot.com` ✓
3. **Forward.** Resolve that hostname back to an address. Does it match the one you started
   with?

Without step 3, anyone who controls reverse DNS for their own address can claim any name
they like. With it, the claim can only be made by somebody who controls the operator's
forward DNS too.

| Outcome | Verdict |
| ------- | ------- |
| forward-confirmed, domain matches | `verified-bot` — proof, used to **allow** |
| resolves, domain does not match | `impersonator` — proof, used to **refuse** |
| no `PTR`, or forward does not match | `impersonator` |
| resolver error, timeout, no answer | **silence** — no evidence either way |

That last row matters. A resolver having a bad afternoon must never look like an
accusation, so a lookup that fails produces nothing rather than a refutation.

## Verifying by published address ranges

Twelve shipped signatures — every AI crawler among them — verify by address rather than by
DNS. It is better where available: a lookup instead of a round trip on the request path,
immune to somebody else's DNS, and it works for crawlers that publish ranges and no useful
`PTR` record.

**The library ships no address data**, deliberately. A range baked into a release is wrong
by the time you install it, and being wrong here means verifying whoever has since been
handed the address. What it ships is the URL each operator publishes:

```js
import { startCrawlerRangeRefresh } from "@osqd/bothandlerjs";

const stop = startCrawlerRangeRefresh(detector);   // twice a day
```

Opt-in, because it makes outbound requests and a dependency-free package quietly fetching
URLs on a timer is not something to inherit by accident. It fails open per source: one
publisher being down leaves every other crawler's ranges as they were.

Two things it refuses outright, because these ranges do not merely *describe* a crawler,
they **verify** one: a list containing a block wider than any crawler owns, and an empty
list. Either would hand verified status — which most policies allow — to whatever it
covered.

Supplying them yourself, for a mirror you control:

```js
detector.updateCrawlerRanges("gptbot", ["203.0.113.0/24"]);
```

## Categories, and why they are the useful handle

Every signature has a category: `search`, `ai`, `seo`, `social`, `monitoring`, `feed`,
`archive`, `security`, `library`, `headless`, `advertising`.

Categories are how a policy expresses a *business* decision without naming thirty crawlers:

```js
{ id: "ai-decline", match: { category: "ai", certain: true }, action: "block" }
```

You will use this in [lesson 10](10-actions-and-presets.md), where the
`decline-ai-training` preset splits the AI fleet by job — training crawlers declined,
fetch-because-a-person-asked served.

## Exercise

Serif wants Googlebot and Bingbot allowed, and anything forging them refused. Write the two
rules — you have not learned rule syntax yet, so write them as sentences and check your
reasoning.

<details>
<summary>Answer</summary>

```js
{ id: "verified-crawler-allow", match: { verdict: "verified-bot" }, action: "allow" }
{ id: "impersonator-block", match: { botClass: "impersonator", certain: true }, action: "block" }
```

Two things worth noticing.

**The allow rule does not name Googlebot.** `verified-bot` already means "an external
authority confirmed this", so naming crawlers individually only creates a list to maintain.

**The block rule keeps `certain: true`** even though `impersonator` is only ever reached
through proof. It costs nothing, and it means the rule still says what it depends on if
somebody later adds a probabilistic route to that class.
</details>

## What you learned

- A name is a claim; for clients with nothing to gain by lying, that is enough
- FCrDNS is three steps, and the forward step is what makes it proof
- Verification confirms *and* refutes, and stays silent when DNS says nothing
- The library ships no address data on purpose; refreshing is opt-in and fails open
- Categories are the handle for business decisions about crawlers

## Reference

- [The signature database](../detection/signatures.md)
- [Verifying a crawler](../detection/verification.md)
- [Runtime changes](../operations/runtime-changes.md) — keeping ranges fresh

Next: [Actors and behaviour](07-actors.md).
