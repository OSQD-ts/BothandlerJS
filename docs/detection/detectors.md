# The detectors

All twenty, each with what it reads, why it exists, what it can conclude, and what it
costs.

← [Documentation](../index.md) · [How detection works](index.md)

---

Every detector returns **evidence**, never a verdict. What each one is allowed to
conclude is as important as what it looks at, so every entry below names its ceiling.

- **cost** — `cheap` is synchronous and in-memory; `io` may make a network call.
- **stage** — `always` runs on every request; `confirming` runs only when a signature
  matched, because there is nothing to confirm otherwise.
- **ceiling** — the highest certainty this detector can produce. Only `certain` can cost
  somebody their access; see [the guard](../concepts/the-guard.md).

```ts
import { defaultDetectors } from "@osqd/bothandlerjs";

new BotHandler({ detectors: defaultDetectors() });        // the default set
new BotHandler({ extraDetectors: [myDetector()] });       // add to it
```

`bothandlerjs detectors --preset protect-content` lists what a configuration actually
installs, which is the reliable answer for your setup.

---

## Single-request detectors

These need nothing but the request in front of them. They work on a replayed log line as
well as on live traffic.

### `self-identified`

**cheap · always · ceiling `certain`**

The client told us what it is. This is the backbone of the proven tier.

When a request arrives saying `python-requests/2.31.0` or `Googlebot/2.1`, nothing is
being *inferred*. We are taking the client at its word — and if that word is a lie, the
misclassification belongs to whoever lied, not to a heuristic that guessed wrong about a
person. That is a point about responsibility rather than about technology, and it is why
this tier can do what the others may not.

What it recognises: the [signature database](signatures.md) (search crawlers, AI
crawlers, monitors, scanners, social unfurlers), bare library tokens (`curl/`, `okhttp`,
`Go-http-client`), and User-Agents that announce automation outright.

```ts
// curl/8.4.0
{ certainty: "certain", summary: "User-Agent identifies curl",
  deterministicBasis: 'The product token "curl/" is emitted by an HTTP library or an ' +
    "automation runtime and by no browser. Nothing a person does in a browser produces it." }
```

A bare token with no browser preamble is `strong` rather than `certain` when it could
plausibly be a person's own script; the database's own entries are `certain`.

### `ua-coherence`

**cheap · always · ceiling `strong`**

Does this User-Agent contradict *itself*?

Every other single-request check compares the User-Agent against something else — the
Client Hints, the header set, the header order. This one needs nothing but the string,
which makes it the only consistency check that still works on a source with no headers at
all: an nginx access line, a CDN log, a WAF event. That is not a small thing when a
replay is the main way people evaluate a policy.

It reads engines, platforms and versions against each other: a Safari token on Windows, a
Chrome version that does not exist, a mobile token with a desktop platform.

### `header-integrity`

**cheap · always · ceiling `certain`**

Compares the header set against what the client it claims to be would actually send.

The `certain` cases here are **protocol violations** rather than absences: two `Host`
headers, a second `Content-Length`, a connection-specific header on HTTP/2. RFC 9112
requires a recipient to reject those; no compliant client emits them.

Everything else — a browser claim with no `Accept`, no `Accept-Language`, no
`Accept-Encoding` — is `moderate` or `strong` and shares a **family**, because a client
missing three browser headers has one property reported three times. See
[families](../concepts/evidence.md#families).

```ts
headerIntegrityDetector({ requireAcceptLanguage: false })   // for an API-only origin
```

### `header-order`

**cheap · always · ceiling `moderate`**

The order headers arrived in, against orderings every mainstream browser respects.

Header order is a fingerprint that a scraper copying your browser's headers usually gets
wrong, because it sets them from a dictionary. The rules are stated as invariants — "`X`
must not appear after `Y`" — verified against Chrome, Firefox, Safari and Edge, and kept
deliberately few. The value is in rules that no browser breaks; modelling any browser's
exact sequence would turn this into a source of false positives on next month's release.

Needs `rawHeaders`; see [adapters](../integration/adapters.md).

### `client-hints`

**cheap · always · ceiling `certain`**

Cross-checks `Sec-CH-UA` against the legacy User-Agent string.

A real Chromium generates both from the same internal state, so they always agree. A
client that rewrites one and forgets the other contradicts itself — visible from a single
request, with no history, no state and no network call, which makes it one of the cheapest
high-value checks there is.

Most of it is `strong` rather than `certain`, because the population that rewrites a
User-Agent without touching Client Hints includes privacy extensions and corporate
middleboxes as well as scrapers.

### `fetch-metadata`

**cheap · always · ceiling `strong`**

`Sec-Fetch-Site`, `-Mode`, `-Dest`, `-User`.

These are **forbidden headers**: page JavaScript cannot set or alter them, so in a real
browser they are generated by the network stack from the actual context of the request.
That makes them unusually hard to forge from inside a page — and their *absence* on an
engine known to send them is informative.

It knows which engine versions ship them (Blink 76+, Gecko 90+), so an old browser is not
accused of missing something it never sent.

### `accept-signature`

**cheap · always · ceiling `strong`**

`Accept` and `Accept-Language` as a fingerprint of what the client will do with the
response.

A browser asking for a page sends a long, specific `Accept` describing the document
formats it renders. A scraper sends `*/*` because it will take anything and parse it
itself. Malformed language lists — values that are not RFC 9110 language ranges — are a
separate and stronger signal, because a browser cannot produce one.

### `probe-signature`

**cheap · always · ceiling `strong`**

What is this request *asking for*?

Every other detector reads the client; this one reads the target, and it exists to close a
gap the rest cannot: the scanner that does not announce itself. `self-identified` catches
sqlmap and Nikto because they say so, and a great deal of hostile traffic does say so. The
rest arrives wearing an ordinary browser User-Agent and asks for `/.env`,
`/wp-admin/setup-config.php`, `/../../etc/passwd` or a path with a SQL payload in the
query string.

```ts
probeSignatureDetector({ extraPaths: ["/internal/admin"] })
```

### `tls-fingerprint`

**cheap · always · ceiling `strong`**

Compares an edge-supplied JA3/JA4 handshake fingerprint against the client the User-Agent
claims to be.

This is the signal that survives a scraper copying every header perfectly: the TLS
handshake is produced by the client's TLS stack rather than by its HTTP code, so a Go or
Python program wearing Chrome's headers still shakes hands like Go or Python.

The library does not compute fingerprints — it cannot see the handshake — so it reads one
your edge computed:

```ts
createFetchAdapter(handler, { tlsFingerprintHeader: "cf-ja3-hash" });

tlsFingerprintDetector({ profiles: { "<ja3 hash>": { name: "Chrome 122", engine: "blink" } } })
```

Without profiles it stays quiet rather than guessing.

### `ip-intelligence`

**cheap · always · ceiling `certain`**

What is known about where this came from. Two range sets, treated very differently.

**`denylist` is `certain`** — and the justification is not technical. *You* configured it.
The library is not inferring anything; it is carrying out an instruction you gave about
addresses you decided about.

**`datacenterRanges` is `moderate`** — a server address is a fact about hosting, not about
intent. VPNs, corporate egress and privacy relays all live there, and so do plenty of
people.

```ts
new BotHandler({
  denylist: ["203.0.113.0/24"],
  datacenterRanges: ["198.51.100.0/16"],
});
```

The library ships **no address data** and refuses to guess any; see
[design decisions](../design/decisions.md).

**Loading a feed.** `fetchAddressList` reads a published list — a reputation feed, a hosting
provider's own ranges — over the same hardened path the crawler ranges use: HTTPS only, a
size cap, `#` and `;` comments stripped, JSON `prefixes` documents or one prefix per line,
and a list that is empty, oversized or contains a block big enough to matter is refused
**whole** rather than in part.

```ts
import { fetchAddressList } from "@osqd/bothandlerjs";

const prefixes = await fetchAddressList({ id: "denylist", url: "https://example.org/drop.txt" });
detector.updateRanges("denylist", prefixes);
```

Two steps, on purpose: fetching is the part that can fail, and installing is the part that
changes what happens to somebody. Nothing is fetched on a schedule unless you schedule it.

And think hard before pointing that at `denylist` rather than `datacenter`. A denylist entry
does not corroborate anything — it decides, and it blocks people. A feed is somebody else's
judgement about an address, refreshed on somebody else's schedule, and an address that was a
bot last month may be a customer's home connection this month.

### `trap`

**cheap · always · ceiling `certain`**

A path no link points at, a form field no rendered browser shows, a header only a script
would echo. Reaching one requires reading the page as data rather than as a page.

```ts
import { renderTrapLink, trapRobotsEntries, DEFAULT_TRAP_PATHS } from "@osqd/bothandlerjs";

app.get("/", (_req, res) => res.send(page + renderTrapLink()));
```

The trap paths belong in your `robots.txt` as `Disallow`, which is what makes the evidence
fair: a crawler that obeys robots never sees them, so touching one is a decision.

---

## Behavioural detectors

These read [the actor's history](../concepts/actors.md). They are the reason the library
keeps state at all, and none of them can reach `certain` — behaviour is a judgement.

### `cadence`

**cheap · always · ceiling `moderate`**

Is this actor's *rhythm* human?

People generate ragged inter-arrival times: they read, scroll, get distracted, open three
tabs, then nothing for four minutes. A loop calling `setInterval` produces gaps clustered
tightly around one value, and the coefficient of variation makes that visible in a single
number.

The check is on *regularity*, not speed, which is what makes it complementary to
`rate-anomaly`: a slow, polite scraper pacing itself at one request every five seconds is
invisible to a rate check and obvious to this one.

### `rate-anomaly`

**cheap · always · ceiling `moderate`**

How fast is this actor going?

Rate is the signal people reach for first and trust most, and it deserves the least trust
of anything here. The *actor* behind a high rate is frequently not one client: a corporate
NAT, a CGNAT pool, a university, a VPN exit and a shared office all present hundreds of
real people under one key.

So it is deliberately conservative, and it is the detector most improved by a better
[`actorKey`](../concepts/actors.md#the-actor-key).

### `crawl-breadth`

**cheap · always · ceiling `weak`**

Reading the site, or enumerating it?

A person revisits: they land on an article, go back to the index, follow a related link,
return. Their ratio of distinct paths to total requests settles well below one. A crawler
walking a sitemap almost never revisits, so its ratio sits near one.

`weak`, because a *welcome* crawler produces exactly this shape and so does a person on a
first visit to a documentation site.

### `id-enumeration`

**cheap · always · ceiling `moderate`**

Somebody working through the identifiers rather than following the links.

`crawl-breadth` sees this as "many distinct paths" — which is also what it sees when a
person reads a documentation site, so it stays `weak` and nothing separates the two.
Measured before this existed: `/user/1` through `/user/120` in order scored 57, a hundred
and twenty scattered ids scored 57, and ordinary article paths scored 57.

What separates them is not *which* ids were asked for but whether they **cover a range**.
People arrive at ids through links, and links do not densely enumerate an integer interval;
a harvester does nothing else. Thirty requests reaching from id 1 to id 33 is a walk; thirty
scattered across a hundred thousand is somebody reading.

It costs three numbers per path shape — a count, a lowest and a highest — rather than a
list of every id seen, which is what makes it affordable for an actor that asks for ten
thousand of them. The last numeric segment is taken as the identifier, so in
`/api/v2/orders/42` the version is part of the shape and the order id is the walk. Numbers
too large to be a counter are ignored: nobody walks epoch seconds.

`moderate`, with the bar set high on purpose. Products in one category often carry
consecutive ids, so somebody browsing a catalogue produces a smaller version of this.

### `probe-volume`

**cheap · always · ceiling `moderate`**

An actor that is looking for something rather than reading anything.

The oldest tell there is for a scanner, and the one this library could not see. Every
verdict here is reached *before* the response exists — that is what lets it shape the
response, and it is also what hides the status code from it. So the application reports it
back:

```ts
const { outcome } = await handler.handle(facts);
// …your application answers…
handler.recordOutcome(facts, response.statusCode);
```

The bundled Node adapter does this for you. Nothing else depends on it: every other
detector works unchanged if you never call it, and this one is simply absent.

Counts **404 and 410 only**. A 403 is usually this library's own doing, and counting it
would let a rule that challenges an actor manufacture the evidence for having challenged
it. A 500 is the site's problem and says nothing about the client.

`moderate`, because a site that has just moved its URLs produces exactly this shape from
perfectly ordinary readers, and so does a feed reader working through removed articles.
Eighty per cent of at least twenty reported responses, by default.

### `transport-coherence`

**cheap · always · ceiling `moderate`**

How a claimed browser *moves*, rather than what it says.

The header checks read one request against the client it claims to be. This reads the
transport underneath and the verbs across a visit — harder to copy, because neither is in
the part of a request most tooling lets you set.

Two things. A claimed browser that negotiated **HTTP/1.0**, which no shipping browser has
offered in over a decade. And a visit made **entirely of HEAD**: one HEAD is a browser
checking a link it is about to follow or a cache revalidating, but a whole visit of them is
something checking what exists without reading any of it.

Both were measured as blind spots before this existed — a client claiming Chrome 120 over
HTTP/1.0, and one whose whole visit was HEAD, each scored exactly what the honest control
scored.

Capped at `moderate`, for different reasons each. HTTP/1.0 is not always the client's
doing: a few older load balancers speak it to the origin, and behind one of those every
request looks like this — which is what `transportCoherenceDetector({ legacyHttp: false })`
is for. An all-HEAD visit is a stronger shape, but a link checker is a real and mostly
harmless thing to be.

### `parameter-sweep`

**cheap · always · ceiling `weak`**

The collection `crawl-breadth` cannot see.

Breadth counts distinct *paths*, and a path carries no query string — so the shape it reads
as "somebody rereading one page" is also the shape of enumerating a catalogue.
`/products?page=1` through `?page=200` is one path and two hundred requests. Measured on
the same two hundred requests expressed both ways: as distinct paths they scored 62 and
were called `suspected-bot`; as `?page=N` they scored 55 and passed as `unknown`. Paginated
collection is not an exotic case — it is how catalogues, search results and APIs are
actually taken.

So this counts the other thing: distinct parameterisations, and how many of them stack onto
a single path. Both halves matter. A high variant count on its own is ordinary — a shop's
own visitors filter and sort — and it is the *concentration* that separates a person
changing their mind from a machine walking an index.

`weak`, for the same reason as breadth: a person paging through search results produces a
smaller version of exactly this. Its value is as a second signal beside an actor that has
already failed something sharper.

### `identity-rotation`

**cheap · always · ceiling `moderate` · off by default**

One actor, several User-Agents. A single client does not change its User-Agent
mid-session; something that does is cycling through a spoofing list.

**Off by default, and think before enabling it.** With the default address-based actor
key, a corporate NAT presents a hundred people's browsers as one actor with a hundred
User-Agents — which is this detector's exact signature and is entirely innocent. Enable it
when your `actorKey` identifies a session rather than a network.

### `session-integrity`

**cheap · always · ceiling `moderate`**

Does this client hold a session?

A browser accumulates state: once your server has set anything — a session cookie, a
consent flag, an A/B bucket — a real browser sends it back on every subsequent request. A
stateless HTTP client sends nothing back however many times it visits.

It only speaks about clients that *claim* to be browsers, and only after your origin has
had a chance to set something.

### `browsing-coherence`

**cheap · always · ceiling `moderate` (human)**

The one that argues the other way.

It reports the marks of a real browsing session — a cache validator (`If-None-Match`), a
cookie jar, a same-site navigation, a plausible `Referer` chain — as **human** evidence,
which the scoring model subtracts from the bot score.

Without it the model has an asymmetry that shows up as false positives on exactly the
people least able to afford them: a researcher on a shared university address reading forty
pages accumulates four suspicions and nothing at all in their defence.

### `clearance`

**cheap · always · ceiling `certain` (human)**

Reads a signed clearance token the client already holds. The library's only source of
human-pointing evidence that is not a guess about headers, and the levels are exact
because overstating any of them would undo the design:

| Level | Certainty | |
| ----- | --------- | --- |
| `operator` | `certain` | Your application said this is a person. We believe you. |
| `pow` | `moderate` | A proof of work was solved. A headless browser solves it too. |

See [the challenge](../challenge/index.md).

### `client-signals`

**cheap · always · ceiling `moderate`**

Reads what the optional [browser script](client-signals.md) reported: `navigator.webdriver`,
an empty language list, zero screen dimensions, a platform that disagrees with the
User-Agent, whether a trusted interaction happened.

**Capped at `moderate`, hard.** Every value here was produced by JavaScript running inside
the client, which is the one place an adversary has complete control. A framework that
wants `navigator.webdriver` to read `false` sets it to `false`. What this genuinely catches
is automation that never bothered to hide — which is a large share of real bot traffic —
and what it must never do is convince you that a clean report means a person.

---

## Confirming detectors

### `crawler-verification`

**io · confirming · ceiling `certain`**

Confirms or refutes a claimed crawler identity. Runs only when a signature matched, because
with no claim there is nothing to confirm and no lookup to make.

Two mechanisms, depending on what the operator publishes:

- **Forward-confirmed reverse DNS.** `PTR` the address, check the name is under the
  crawler's domain, then resolve that name forward and check it comes back to the same
  address. A confirmation is `verified-bot`; a **refutation** is `certain` evidence of an
  impersonator, and the strongest thing this library ever concludes about a forgery.
- **Published address ranges.** A lookup rather than a round trip. See
  [verifying a crawler](verification.md).

A resolver that is merely *unhappy* must reach a different verdict from one that
*disproves* the claim, and it does: a timeout produces no evidence at all.

---

## Related

- [How detection works](index.md) — the pipeline these run in
- [Writing a detector](writing-a-detector.md) — the contract, and the rules on certainty
- [Evidence and certainty](../concepts/evidence.md) — what the tiers mean
