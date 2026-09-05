# The traffic corpus

526 shapes of real web traffic — 739 requests, 6,002 header lines — paired with what
the library ought to conclude about each, and a harness that runs them against
**your** configuration.

```bash
npm run corpus                             # the protect-content preset
npm run corpus -- --preset protect-data
npm run corpus -- --audience human --verbose
npm run corpus -- --tag known-cost
```

The section to read first is **FALSE POSITIVES**. Everything else is diagnostics;
that one is people your configuration would have turned away.

---

## What it is for

A bot policy is a claim about traffic you have not seen yet. Unit tests check that a
detector does what its author intended; they cannot tell you whether the *policy*
built from those detectors is safe to point at the internet. This corpus can, because
it is made of the internet: real User-Agent strings, real header sets in the order
real clients send them, real behavioural shapes, each traced to where it came from.

The single most important thing in it is the `human` audience. Every case marked that
way carries an automatic `neverAction: ["block", "drop", "redirect"]`, enforced by the
harness regardless of what the case's own expectations say. Adding a human case
therefore protects you the moment you add it, without anyone having to remember to
write the assertion.

---

## Layout

| File | What is in it |
| ---- | ------------- |
| `schema.ts` | Case shape, the `human()`/`bot()` helpers, pacing helpers |
| `headers.ts` | 30 real browser profiles — **in the order each engine sends headers** — plus the conditional apparatus: Client Hints, `Sec-GPC`, `Save-Data`, `Sec-Purpose`, `Early-Data`, cache validators |
| `cookies.ts` | Realistic cookie jars: GA4, Meta, Cloudflare bot management, TCF consent strings |
| `ranges.ts` | Fictional published crawler ranges, from RFC 5737 documentation space |
| `humans.ts` | People: privacy-hardened, assistive, legacy, mangled by infrastructure |
| `humans-browsers.ts` | Every current engine on every platform, in the scenarios people actually use them for |
| `humans-apps.ts` | 40 in-app WebViews and Electron desktop applications |
| `benign-bots.ts` | Search crawlers, link unfurlers, monitoring, feeds and podcasts, archives |
| `ai-crawlers.ts` | The AI fleet, split by job: training, search, and fetch-on-behalf-of-a-user |
| `unwanted.ts` | SEO and market-intelligence crawlers |
| `crawlers-regional.ts` | Naver, Seznam, Coc Coc, Sogou, 360, Shenma, Qwant, Mojeek, and the Google and Microsoft specialist fleets |
| `crawlers-vertical.ts` | Commerce, jobs, travel, news, academic, archival, compliance, brand protection |
| `advertising-email.ts` | Ad verification, and the mail gateways that open your links before anyone clicks |
| `libraries-extended.ts` | 50 HTTP clients across every ecosystem, in their real header orders |
| `cdn-gateways.ts` | CDN origin pulls, API gateways, service meshes, forwarding headers |
| `tooling.ts` | HTTP libraries, automation runtimes, security scanners |
| `adversarial.ts` | Forged identities, fabricated User-Agents, the evasion ladder, traps, wordlist probes, framing abuse |
| `infrastructure.ts` | Health probes, webhooks, your own clients, browser prefetch, shared egress |
| `reputation.ts` | Address ranges and prior clearance |
| `runner.ts` | The harness and the scorecard |

---

## Two details that make it honest

**Header order is a fingerprint, so the profiles reproduce it.** Chromium emits
`Host, Connection, sec-ch-ua…, User-Agent, Accept, Sec-Fetch-*, Accept-Encoding,
Accept-Language`; Gecko leads with identity and closes with Fetch Metadata; WebKit
interleaves the two. A fixture that invents an order is testing a client that does not
exist — and `python-requests` sending `Accept-Encoding` before `Accept` is a real
signal that only appears if the corpus gets this right.

**DNS is controlled, not mocked away.** Each case declares the answers it wants, so
the difference between *"the operator's DNS disproves this claim"* and *"our resolver
was briefly unhappy"* can actually be tested. Those must reach different verdicts —
one is an impersonator, the other is Googlebot during a DNS blip — and only a
controlled resolver can prove they do.

---

## Reading the scorecard

- **False positives** — human cases denied service. Must be zero. Anything else is a
  bug in the policy, or in the library, and never in the corpus.
- **By audience** — pass rate and the spread of actions each group received. This is
  where you see the *shape* of a policy: how much of your benign-bot traffic is
  tagged versus challenged, how much of the hostile traffic is actually stopped.
- **Detector coverage** — how many cases each detector fired on, and which installed
  detectors nothing exercised. An unexercised detector is a gap in the corpus, not in
  the library: it is one whose next regression nobody will notice.
- **Proven automation** — the share of genuinely automated cases that reached a
  `certain` verdict. It is deliberately not 100%. See the evasion ladder.

---

## The evasion ladder

Five cases in `adversarial.ts` that run from crude to genuinely undetectable, and the
top rungs are *expected to fail*:

1. Copied the User-Agent only — caught easily, four independent signals.
2. Copied the whole header set but not the order — caught, weakly.
3. Copied the order and the Client Hints too — **not caught** from a single request.
4. …and paced at a machine-perfect rhythm — caught by cadence, and only by cadence.
5. …and paced like a person, a few pages per address — **not caught at all**.

Level 5 is in the corpus precisely so that nobody can claim the library catches it.
At that point the difference from a person has stopped being technical, and what
defeats it is cost — a proof of work, or an account — not detection.

---

## Adding a case

```ts
human({
  id: "kebab-case-and-unique",
  title: "What a reader needs to picture it",
  category: "mainstream-browser",
  provenance: "Where this shape came from: a UA list, a vendor doc, a log line, a spec",
  requests: [browser("chromeWindows")],
  expect: { verdict: "unknown", maxScore: 0 },
});
```

`provenance` is required and enforced. A fixture nobody can trace is a fixture nobody
can update when the world moves — and this is a corpus about a world that moves.

Cases needing configuration the defaults do not supply declare it, and are **skipped
and reported** rather than silently failing:

```ts
requires: ["trap-form-field:company_url"],
```

Cases that should arrive already holding clearance declare the level; the harness asks
the handler under test to mint the token, since only it holds the signing secret:

```ts
clearance: "operator",
```

---

## Replaying it over a real socket

```bash
npm run demo             # terminal 1
npm run simulate:corpus  # terminal 2
```

The harness above calls `assess()` in process. `npm run simulate -- --corpus` sends
the same cases down a real TCP connection to the demo server, which tests everything
between the socket and the engine: the adapter, Node's header parsing, whether the
wire order survives into `rawHeaders`, cookie parsing, and address resolution through
the forwarding headers.

A case that passes in process and fails on the wire has found an adapter bug. One
already did — `exposeVerdictHeaders` was honoured on every response except the
challenge interstitial, so anything reading the verdict off a response saw it
everywhere except the place a suspected client actually lands.

Cases with no wire equivalent are skipped and counted: HTTP/2 fixtures, cases
declaring their own DNS answers, cases needing a clearance token only the server can
mint, and cases needing ranges or lists the demo does not load.

## Testing your own configuration

```ts
import { runCorpus } from "bothandlerjs/corpus";

const scorecard = await runCorpus({
  create: ({ resolver, clock }) => new BotHandler({ ...myProductionConfig, resolver, clock }),
  assertActions: false,   // your actions are yours; the invariants are not
});

if (scorecard.falsePositives.length > 0) throw new Error("this policy turns people away");
```

`assertActions: false` is the right setting for a policy that is not one of the
presets. Which *action* a case receives is a property of your rules; the verdict, the
certainty and `neverAction` are properties of the traffic and hold everywhere.
