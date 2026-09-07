# Lesson 5 — The detectors

**Goal:** know what each of the twenty detectors reads, what it costs, and what it is
allowed to conclude — then turn one off and watch the score move.

← [Course](index.md) · Prev: [The guard](04-the-guard.md) · Next: [Identity and verification](06-identity.md)

---

## What is installed

```js
for (const d of detector.describeDetectors()) {
  console.log(`${d.id.padEnd(22)} ${d.cost.padEnd(6)} ${d.stage}`);
}
```

### Checkpoint

```
self-identified        cheap  always
trap                   cheap  always
ip-intelligence        cheap  always
probe-signature        cheap  always
header-integrity       cheap  always
ua-coherence           cheap  always
client-hints           cheap  always
fetch-metadata         cheap  always
accept-signature       cheap  always
header-order           cheap  always
rate-anomaly           cheap  always
cadence                cheap  always
crawl-breadth          cheap  always
session-integrity      cheap  always
browsing-coherence     cheap  always
crawler-verification   io     confirming
```

**Sixteen of twenty ship on by default.** The other four —
`identity-rotation`, `tls-fingerprint`, `clearance`, `client-signals` — each need something
from you, and you will switch three of them on later in the course.

## Cost and stage

Every detector declares two things, and they decide when it runs.

**`cost`** is `cheap` or `io`. Cheap detectors are pure string and header work and run
sequentially in microseconds. `io` detectors touch the network or a shared store, run
concurrently, and each gets its own timeout — `detectorTimeoutMs`, default 300 ms.

**`stage`** is `always` or `confirming`. The confirming stage runs only when an earlier
detector produced something worth confirming, which is why `crawler-verification` does no
DNS at all for a request that never claimed an identity.

A detector that throws or times out is dropped; **the request is not**. A bot filter that
fails closed is an outage with extra steps.

## What each one does

### Identity

| Detector | Ceiling | Reads |
| -------- | ------- | ----- |
| `self-identified` | `certain` | 161 signatures, 389 tokens, in one Aho–Corasick pass. Also catches unrecognised crawlers that name a contact URL, and bare client tokens with no browser preamble |
| `crawler-verification` | `certain` | Forward-confirmed reverse DNS, or published address ranges. **Confirms and refutes** |

### Single-request consistency

| Detector | Ceiling | Reads |
| -------- | ------- | ----- |
| `header-integrity` | `certain`* | Header set against the claimed client, plus framing rules a recipient must enforce. `certain` only for the three protocol violations |
| `ua-coherence` | `strong` | The User-Agent against itself: two engines, two platforms, Chrome on an iPhone, a version its platform never received. Needs no other headers, so it works on a log line |
| `client-hints` | `certain`* | `Sec-CH-UA` against the User-Agent. `certain` only for a self-declared headless brand |
| `fetch-metadata` | `strong` | `Sec-Fetch-*` absence on engines that send them, and incoherent combinations. Page JavaScript cannot set these |
| `accept-signature` | `strong` | `Accept: */*` on a navigation; `Accept-Language` that is not valid grammar |
| `header-order` | `moderate` | Orderings no mainstream browser produces. HTTP/1.x only |

### Behaviour over time

| Detector | Ceiling | Reads |
| -------- | ------- | ----- |
| `rate-anomaly` | `moderate` | Arrivals in a short window. Reports; never concludes |
| `cadence` | `moderate` | Coefficient of variation of the gaps. Catches the polite scraper pacing itself *under* your rate limit |
| `crawl-breadth` | `weak` | Distinct paths against total requests: reading a site against enumerating it |
| `parameter-sweep` | `weak` | Distinct query strings against the paths they sit on. Catches the collection that leaves the path unchanged — `?page=1..200` |
| `session-integrity` | `moderate` | A "browser" that never carries a cookie |
| `id-enumeration` | `moderate` | A contiguous run of numeric ids under one path shape — walking `/user/1..n` rather than following links |
| `probe-volume` | `moderate` | The share of an actor's requests answered 404. Needs `recordOutcome`; the Node adapter wires it up |
| `transport-coherence` | `moderate` | The HTTP version and the verbs across a visit: a "Chrome" on HTTP/1.0, a visit made only of HEAD |
| `identity-rotation` | `moderate` | One actor, several User-Agents. **Off by default** — under an IP actor key this fires on every corporate NAT |
| `browsing-coherence` | `moderate` | The only detector arguing *for* the client. Human-pointing, so it discounts |

### Environment and traps

| Detector | Ceiling | Reads |
| -------- | ------- | ----- |
| `trap` | `certain` | Hidden links, hidden fields, trap headers — [lesson 8](08-traps.md) |
| `probe-signature` | `strong` | What the request *asks for*: `/.env`, `/.git/config`, a JNDI lookup, a `TRACE` |
| `ip-intelligence` | `certain`* | Your denylist (`certain` — your decision, not our inference) and datacenter ranges (`moderate`). Ships no data |
| `tls-fingerprint` | `strong` | JA3/JA4 from your edge. **Off by default** |
| `clearance` | `certain` | A signed clearance token. `certain` only at `operator` level — [lesson 11](11-the-challenge.md) |
| `client-signals` | `moderate` | What a browser-side script reported. **Capped at `moderate`, permanently** — [lesson 15](15-extending.md) |

## Do this: turn one off

`header-integrity` was doing most of the work on the copied-User-Agent request from lesson
1. Remove it and see:

```js
import { BotHandler, createFacts, defaultDetectors } from "@osqd/bothandlerjs";

const without = new BotHandler({
  detectors: defaultDetectors().filter((d) => d.id !== "header-integrity"),
});

const spoof = createFacts({
  method: "GET", url: "/books", ip: "203.0.113.55",
  headers: { host: "serif.example", "user-agent": CHROME["user-agent"], accept: "*/*" },
});

console.log("with   ", (await detector.assess(spoof)).score);
console.log("without", (await without.assess(spoof)).score);
```

The score falls from 45 to 15 — the two `header-integrity` absences were most of the case.

Note `detectors:` **replaces** the set entirely. To add without removing, use
`extraDetectors`.

## Adjusting one rather than removing it

Several detectors take options. The one you are most likely to want is
`probe-signature`, whose second tier is platform administration paths — `/wp-login.php`,
`/administrator`, `/phpmyadmin`. Those are a probe on sites that do not run those
platforms and the *front door* on sites that do:

```js
import { defaultDetectors, probeSignatureDetector } from "@osqd/bothandlerjs";

const detectors = defaultDetectors().map((d) =>
  d.id === "probe-signature" ? probeSignatureDetector({ ignore: ["/wp-login.php", "/wp-admin"] }) : d,
);
```

That tier is capped at `moderate` precisely so that forgetting is survivable: an author
signing in to their own site scores 21 and is served.

## Exercise

Serif runs on a Fetch runtime behind Cloudflare. Which detector should you drop, and why?

<details>
<summary>Answer</summary>

**`header-order`.** Fetch runtimes normalise header order, so it has nothing real to read
there and will either return nothing or reason from an ordering the platform invented
rather than the client.

```js
detectors: defaultDetectors().filter((d) => d.id !== "header-order")
```

More generally: a detector reading something your infrastructure rewrites is not neutral,
it is *misleading*. The same reasoning is why `identity-rotation` is off by default under an
IP-based actor key.
</details>

## What you learned

- Sixteen of twenty detectors are on by default; the rest need something from you
- `cost` and `stage` decide when a detector runs, and confirming work is skipped when
  nothing claimed an identity
- A failing detector is dropped, never the request
- Each detector has a ceiling it may not exceed
- `detectors` replaces; `extraDetectors` adds

## Reference

- [The detectors](../detection/detectors.md) — all twenty in full
- [How detection works](../detection/index.md) — the pipeline and its budgets

Next: [Identity and verification](06-identity.md).
