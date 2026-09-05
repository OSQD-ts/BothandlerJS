# Verifying a crawler

Turning "I am Googlebot" into a verdict — or into a refutation.

← [Documentation](../index.md) · [The detectors](detectors.md)

---

A User-Agent is a claim. Two mechanisms can check one, depending on what the operator
publishes, and both are run by
[`crawler-verification`](detectors.md#crawler-verification) — which only runs at all when
a [signature](signatures.md) matched, because with no claim there is nothing to check.

## Forward-confirmed reverse DNS

The mechanism Google, Bing, Yandex, Baidu and Apple document for their own crawlers:

1. `PTR` the client address → `crawl-66-249-66-1.googlebot.com`
2. Check the name ends in a domain the signature lists.
3. Resolve that name forward → does it come back to the same address?

Step 3 is the one that matters. Reverse DNS alone is controlled by whoever owns the
address block; forward-confirming it means the *crawler's* DNS has to agree.

```ts
{ verification: { kind: "fcrdns", domains: ["googlebot.com", "google.com"] } }
```

| Outcome | Evidence |
| ------- | -------- |
| Forward-confirmed under a listed domain | `certain` → `verified-bot` |
| Resolves, but to a name outside the domains | `certain` refutation → `impersonator` |
| No answer, timeout, resolver error | **nothing** |

That last row is the important one. A resolver having a bad afternoon must not look like
an accusation, so an unhappy lookup produces no evidence at all — not weak evidence, none.

DNS results are cached (`cachingResolver`), and the whole thing runs under
`detectorTimeoutMs`.

```ts
new BotHandler({
  resolver: cachingResolver(nodeDnsResolver(), { ttlMs: 600_000, maxEntries: 5_000 }),
});
```

### `treatMissingPtrAsForgery`

Off by default, and it should stay off unless you know what you are doing. Some legitimate
crawlers have no `PTR` at all; treating absence as forgery converts a gap in somebody
else's DNS into an accusation.

## Published address ranges

Twelve shipped signatures verify by address instead — every AI crawler among them. Where
it is available this is better than reverse DNS in three ways: a lookup instead of a
network round trip on the request path, immune to somebody else's DNS having a bad
afternoon, and it works for the several crawlers that publish ranges and no useful `PTR`.

**The library ships no address data**, and that is deliberate: a range baked into a
release is wrong by the time somebody installs it, and being wrong here means verifying
whoever has since been handed the address. What it ships is the URL each operator
publishes.

```ts
import { startCrawlerRangeRefresh } from "bothandlerjs";

const stop = startCrawlerRangeRefresh(detector);          // twice a day by default
```

Opt-in, because it makes outbound requests, and a dependency-free package quietly fetching
URLs on a timer is not something to inherit by accident.

### What it will and will not accept

It reads the two formats anybody publishes: a JSON document with a `prefixes` array of
`{ ipv4Prefix }` / `{ ipv6Prefix }` objects — the shape Google standardised and the AI
crawlers copied — and a plain-text list of one address or CIDR per line.

Two things are refused **whole**, because these ranges do not merely describe a crawler,
they *verify* one — and an address inside them is a `verified-bot`, which most policies
allow:

- a list containing a block bigger than any crawler owns (`/8` or wider for IPv4);
- an empty list.

A partially-parsed list is refused too. The operation replaces a set, and a set that half
arrived is worse than the one already installed.

### It fails open, per source

One publisher being down, having moved its file, or serving something unrecognisable
leaves every other crawler's ranges as they were — and leaves *that* crawler's ranges as
they were too, which is the state it was in before you called this. Failures are raised as
warnings, so they land in the [dashboard's notices](../operations/dashboard.md).

```ts
const result = await refreshCrawlerRanges(detector, { by: "the nightly job" });
result.updated;   // [{ id: "googlebot", prefixes: 42 }]
result.failed;    // [{ id: "gptbot", reason: "503 Service Unavailable" }]
```

### Supplying your own

```ts
await refreshCrawlerRanges(detector, {
  sources: [{ id: "gptbot", url: "https://internal.example/mirrors/gptbot.json" }],
});

// or set them directly, from any source you like
detector.updateCrawlerRanges("gptbot", ["203.0.113.0/24"]);
```

Mirroring the lists internally is a reasonable thing to do: it removes an outbound
dependency from your servers and lets you review a change before it takes effect.
`PUBLISHED_CRAWLER_RANGES` is the shipped list of pointers, and nothing stops you pinning
all of them.

## Related

- [The signature database](signatures.md) — what is being verified
- [Design decisions](../design/decisions.md) — why no address data ships
- [Runtime changes](../operations/runtime-changes.md) — ranges are a runtime change like any other
