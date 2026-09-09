# The signature database

How a client is recognised by name, and what a name is worth.

← [Documentation](../index.md) · [The detectors](detectors.md)

---

205 signatures, 389 tokens, matched in a single Aho–Corasick pass over the lower-cased
User-Agent. One pass regardless of how many signatures there are, which is why adding to
this costs nothing measurable.

```ts
interface BotSignature {
  id: string;              // stable; appears in rules, logs and metrics
  name: string;            // "Googlebot"
  tokens: readonly string[];   // lower-case literals; any one identifies it
  category: BotCategory;
  benign: boolean;
  robotsAgent?: string;    // the name to write in robots.txt
  verification: Verification;
  docs?: string;           // the operator's own documentation
}
```

## Categories

`category` is what most policies actually match on, because it carries intent in a way an
individual name does not.

| Category | Examples | Typical policy |
| -------- | -------- | -------------- |
| `search` | Googlebot, Bingbot, DuckDuckBot, Yandex, Baidu, Seznam, Naver | allow |
| `ai` | GPTBot, ClaudeBot, PerplexityBot, CCBot, Bytespider, Amazonbot | a business decision |
| `seo` | AhrefsBot, Semrush, Majestic, Moz | usually rate-limit |
| `social` | facebookexternalhit, Twitterbot, Slackbot, Discord, Bluesky | allow — these are people sharing links |
| `monitoring` | UptimeRobot, Pingdom, Checkly, Better Uptime | allow |
| `archive` | ia_archiver, Common Crawl | your call |
| `feed` | Feedly, podcast clients, RSS readers | allow |
| `scanner` | sqlmap, Nikto, Nuclei, masscan | block |
| `library` | curl, wget, python-requests, Go-http-client, okhttp | usually challenge |
| `headless` | HeadlessChrome, Playwright, Puppeteer, Selenium | usually challenge |
| `embedded` | Smart TVs, set-top boxes, game consoles | allow |
| `commerce` | idealo, Kelkoo, PriceRunner, Trivago, Skyscanner, Indeedbot | a commercial decision |
| `academic` | Crossref, OpenAlex, university web-science crawls | usually allow |
| `accessibility` | Siteimprove and other WCAG auditors | allow |
| `email-security` | Proofpoint, Mimecast, Barracuda, Cisco Secure Email | allow |

`email-security` is a mail or messaging gateway checking a link somebody was sent, before
they are allowed to click it — and it is separate because of who pays when it is blocked. A
social preview that fails costs a card; one of these failing tells a real person, in their
inbox, that their mail contained a link that could not be verified, and they were never the
one crawling. They arrive with none of a browser's marks — from a datacentre, once, no
cookie, no referer — because the request is automation acting on a human's behalf.

The other three are separate from their nearest neighbours because the decision is. A price
comparator is not an SEO auditor — nothing there is auditing your site for you, and the
same crawler is a distribution channel to one retailer and a competitor's research tool to
the next, which is why nothing in `commerce` is marked benign. A citation index is not a
model being trained, and an operator refusing the second is often glad of the first. And an
accessibility crawler is not an uptime probe: it is usually commissioned by the site's own
owner and then forgotten about, so blocking it does not reduce load, it makes an
accessibility report look clean by removing the evidence.

```ts
{ id: "no-ai", match: { category: "ai" }, action: "block", reason: "Not for model training." }
```

## Verification

What, if anything, can check the claim:

```ts
type Verification =
  | { kind: "fcrdns"; domains: readonly string[] }   // reverse DNS, forward-confirmed
  | { kind: "ip-ranges"; publishedAt?: string }      // an address list the operator publishes
  | { kind: "proof"; via: string }                   // something only you can check
  | { kind: "none" };                                // no published mechanism
```

`none` is honest rather than lazy: a great many crawlers publish nothing that can confirm
them, and for those the claim is **unfalsifiable**. The library neither confirms nor
accuses — it records what the client said and lets the policy decide what a self-declared
identity is worth. See [verifying a crawler](verification.md).

**But you may be able to check what this library cannot.** Your CDN has often already
verified the crawler and says so in a header it adds; some bots now sign their requests;
you may hold ASN data. None of those belong inside a detection library — two need a
network dependency and the third needs a key it has no business fetching — so instead you
supply the answer:

```ts
new BotHandler({
  crawlerVerification: {
    verifiers: {
      // Whatever you can prove, however you prove it.
      gptbot: (ctx) => (ctx.facts.headers["cf-verified-bot"] === "gptbot" ? "verified" : "unknown"),
    },
  },
});
```

A verifier returns `"verified"`, `"refuted"` or `"unknown"`, runs before the built-in check
for that signature, and a definite answer settles it — which also means no DNS lookup.
`"unknown"` falls through to whatever the library can do on its own, and so does a throw:
an unreachable key server must never read as an accusation, or an outage becomes a wave of
blocked crawlers.

## What a name is worth

A matched signature makes `self-identified` produce `certain` evidence, and this is the
part worth being precise about: **the certainty is about the declaration, not about the
identity**.

`Googlebot/2.1` in a User-Agent proves that something *claimed to be Googlebot*. It is
`confirmed-bot` — automation, certainly, because no person's browser sends that string —
and it becomes `verified-bot` only once `crawler-verification` confirms it. A forgery
that is refuted becomes an `impersonator`, which is the strongest thing the library ever
concludes about anybody.

So a rule matching `identity: ["googlebot"]` alone matches forgeries too. Match on
proof when it matters:

```ts
{ id: "trust-google", match: { identity: ["googlebot"], verdict: "verified-bot" }, action: "allow" }
```

## Adding your own

```ts
new BotHandler({
  extraSignatures: [
    {
      id: "acme-partner",
      name: "Acme partner integration",
      tokens: ["acme-partner-sync"],
      category: "library",
      benign: true,
      verification: { kind: "ip-ranges" },
    },
  ],
});

// and, if you know where they call from:
detector.updateCrawlerRanges("acme-partner", ["198.51.100.0/24"]);
```

`signatures` replaces the shipped set entirely; `extraSignatures` adds to it. Tokens are
lower-case literals rather than patterns, which is what keeps the match linear.

## Related

- [Verifying a crawler](verification.md) — turning a claim into a verdict
- [robots.txt](../policy/robots.md) — `robotsAgent` is what makes this generatable
- [The detectors](detectors.md#self-identified)
