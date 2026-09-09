# Correlating a client's own requests

Most of this library reads one request. A smaller and more valuable part reads a
*series* — what an actor has done across many requests — because the tells that matter
most are not visible in any single one. A wordlist scan is a hundred ordinary-looking
404s. A scrape is a thousand ordinary-looking page loads. Nothing in any one of those
requests is remarkable; the shape of all of them together is.

This page is about the join: what makes two requests "the same client", and what each
kind of join is worth.

## The problem with joining on an address

Every cross-request detector needs to decide which requests belong together, and until
recently there was only one way to decide it — the **actor key**, derived from the
client address. It is available on every request, it costs nothing, and it is wrong in
both directions:

- **It merges people who are unrelated.** An office, a school, a household and a mobile
  carrier all put many people behind one address. Anything inferred about "the actor" is
  really about a crowd.
- **It splits a client that is one thing.** A scraper on a rotating proxy pool is a new
  actor every few requests, and a phone changing networks is a new actor several times a
  day.

Both errors have teeth. The first is how a library ends up denying somebody for a
stranger's behaviour. The second is how a scraper walks straight past every per-actor
threshold by changing address more often than the threshold counts.

One detector was left unwritten for exactly this reason. `identityRotationDetector` —
the client that arrives as Chrome, then as curl, then as Googlebot — fires on any
address fronting several browsers, which describes every corporate network on the
internet. It ships, but it is not installed by default, and the note in
`defaultDetectors()` says why: it is only safe once your actor key is narrower than an
address.

## The marker

A marker is a signed cookie this server issues and reads back. It is off by default.

```ts
new BotHandler({
  probe: { secrets: [process.env.MARKER_SECRET] },
});
```

Two requests carrying the same marker came from the same client. Not the same address,
not the same network — the same browser profile, because the marker holds an HMAC only
this server can produce and only that client received. That single fact is what makes
the rest of this page possible, and it is what turns "a client at this address claimed
two identities" into "this client claimed two identities".

It contains a random id, a validity window, and three short hashes standing for the
identity claimed when it was issued. It carries no identifier of a person, is
first-party, is `HttpOnly`, and expires on its own. Like every token here it is **signed
and not encrypted**, so nothing secret may go in one.

### What it costs

Verifying a marker is an HMAC, and a session presents the same cookie on every request,
so successful verifications are cached — with expiry re-checked on each hit, and failures
never cached, since caching those would let anyone fill the cache with unique junk. The
probe costs roughly 5% of an assessment with a marker held, and nothing at all when the
client holds none.

Network fan-out is sketched into 128 bits per marker rather than remembered as a set of
addresses, which measured at 55.6 MB with both caps full. The estimate carries a few
percent of error either way — 16 real networks read as 17 — so `marker-fanout`'s threshold
is a soft boundary. With everything full the probe holds well under a megabyte.

A `Set-Cookie` makes a response uncacheable by most shared caches, so the probe issues a
marker **only when the client is not already holding a valid one** — for an ordinary
visitor, the first request of a session and no other. That is also why the marker is not
reissued to refresh it, and why verified crawlers are never issued one at all: Googlebot
keeps no cookies, so a marker sent to it is a header that never comes back.

### Secrets

`secrets` is required, and deliberately has no default. A secret generated at startup
would read every marker minted by another replica — or by this one before a restart — as
*forged*, turning the strongest signal here into a machine for accusing ordinary
visitors. The first secret signs and all of them verify, so rotation is a prepend
followed by a removal one marker lifetime later.

Rotation does not disturb anything. The identity hashes inside a marker are derived under
a fixed salt rather than under the signing secret, precisely so that prepending a key
does not silently re-describe every visitor as a different browser.

## What the marker makes visible

| Detector | Ceiling | Reads |
| --- | --- | --- |
| `identity-drift` | `strong` | The identity claimed now against the one claimed when the marker was issued |
| `marker-integrity` | `strong` | A marker presented with a signature this server could not have produced |
| `marker-fanout` | `moderate` | Distinct networks one marker has been presented from |
| `marker-persistence` | `moderate` | A client that sends cookies but never returns the one this server set |
| `challenge-reaction` | `strong` | What a client did in the seconds after it was challenged |
| `challenge-integrity` | `moderate` | Solutions replayed, or returned faster than the puzzle allows |

All of them are installed automatically when `probe` is configured and are absent
otherwise, because a marker nobody issued is a marker nobody can fail to return.

### Identity drift, and why the parts are weighed separately

A **browser family** that changes — Chrome to curl, Firefox to Googlebot — has no benign
reading. Software does not change what it is, so one of the two claims is false and the
evidence is `strong`.

A **platform** that changes does have a benign reading, and a common one: "Request
desktop site" on a phone rewrites the User-Agent to claim a desktop, and the person doing
it is a person. A language changes when somebody changes their language. Those are
reported at `moderate` and named as the soft case in the summary, or turned off:

```ts
identityDriftDetector({ reportSoftDrift: false });
```

### Not returning the marker, and who that describes

`marker-persistence` deliberately says nothing about a client that sends **no** cookies at
all. That client is `session-integrity`'s business, and it already reports it at a weight
chosen for the people who produce it — people who block cookies. Having both speak is one
observation counted twice, landing on exactly that population: measured on the corpus, the
overlapping version took the `cookies-blocked` case from 21 to 38 and put +24 on five
ordinary browsing sessions.

So this asks the narrower question only a marker can answer — the client is demonstrably
keeping cookies, and ours is not among them — and the two share an evidence `family`, so
even where both apply the stronger stands rather than the two summing.

### Reaction beats observation

`challenge-reaction` is the strongest idea here, and the reason is structural. Every
other detector reads traffic that would have happened anyway and argues backwards from
it. This one reads a response to a stimulus **we chose**: we decided when the challenge
went out, so a client that changes what it claims to be within seconds of receiving one
is reacting to it. There was no reason to look at that moment except that we created it.

It reports two things — a changed identity, and never answering at all across repeated
asks. The first is `strong` when a marker ties the two requests together and `moderate`
when only the address does, because that is genuinely how much less an address-based join
is worth. The second is capped at `moderate` forever: a person with JavaScript disabled
produces it every time, and they are a person.

## Comparing a client with everybody else

The marker answers "is this the same client". A different set of questions needs the
opposite comparison — not this client against itself, but this client against the rest of
your traffic. It is also off by default:

```ts
new BotHandler({
  site: { warmupRequests: 5000 },
});
```

| Detector | Ceiling | Reads |
| --- | --- | --- |
| `distributed-walk` | `moderate` | A numeric range walked across many clients, none of which walks enough of it alone |
| `path-novelty` | `moderate` | A client whose requests are almost all for paths nobody else has asked for |
| `miss-baseline` | `moderate` | This client's miss rate against the site's own |
| `path-campaign` | `moderate` | A path the site never served that many unrelated clients suddenly want |

### Warmup is the whole safety story

Nothing is reported until `warmupRequests` have been observed, and that number is the most
important setting here. A baseline is a claim about what is normal, and a claim drawn from
four hundred requests is not one: on a quiet site at three in the morning *every* path is
one nobody else has asked for, because nothing has been asked for. A profile consulted
early does not merely fail — it fails confidently, about everybody. The failure mode of the
whole module is silence, which is the correct direction for something whose mistakes land
on all your visitors at once.

The same reasoning caps every detector here at `moderate`. A baseline is wrong exactly when
a site is most unusual: the day of a redesign, the hour a campaign lands, the migration
that leaves half the URLs missing.

### What each one is really for

`distributed-walk` addresses the one threat per-actor thresholds miss **by construction**.
Split an id range across five hundred addresses at one request a minute each and every
actor is unremarkable, `id-enumeration` never fires for anybody, and the range is still
walked end to end. It is only visible in the union. What separates it from a busy shop is
that enumeration *covers* a contiguous range and visits each id about once, while real
readers cluster on popular items and return to them — so coverage and the revisit ratio
must both agree, and either alone would report an ordinary catalogue.

`path-novelty` is a self-maintaining wordlist. A wordlist is a list of paths that exist on
*some* sites; on yours most of them do not exist and nobody has ever asked for them. It
catches the scanner whose list is newer than the one this library ships.

`path-campaign` is its inverse, and catches what it misses. A freshly disclosed
vulnerability looks like one URL nobody had ever requested being requested by hundreds of
unrelated clients within the hour — each of them making a single request, which is nothing
at all on its own. The miss rate is **required** rather than optional here, because many
clients arriving at once on a brand-new URL is also exactly what a successful launch looks
like. What separates them is whether the site had anything to serve.

**The known cost of `path-campaign`** is a broken link. Somebody shares a URL with a typo
and thousands of real people follow it within the hour, which from the server is a path
the site has never served, requested by many unrelated clients, answered `not found` every
time — the firing shape exactly. Those people are reported at `moderate` and never
refused; the corpus carries the case (`broken-link-shared-widely`) and holds it to the
never-deny guarantee under every shipped preset.

**`distributed-walk` needs both of its bounds.** The revisit ratio is checked from above
*and* below, and the lower bound is what makes it usable on a real site. Ids spread across
a six-figure catalogue coarsen the bitmap until one bucket stands for hundreds of ids;
ordinary browsing then touches nearly every bucket, so coverage reads 1.0 and the
estimated id count runs far ahead of the requests that were actually made. Requiring the
visits to account for the ids claimed is what rejects an estimate that has left the
evidence behind — measured on a simulated shop, sixty long-tail shoppers were reported
before that bound existed and none after.

`miss-baseline` is `probe-volume` done relative. A fixed 80% threshold reports everybody on
a site mid-migration and stays silent on a tidy one where a client missing a third of the
time is remarkable.

### What it costs

Everything is bounded, and the bounds are the interesting part, because a client picks its
own paths and therefore picks how much there is to remember. Walk ids are held as a
**1024-bit map over the range rather than as a set of numbers**: a set measured at 45 MB
for a table anybody could fill on purpose by requesting `/anything/1`, while the bitmap is
128 bytes however wide the range grows, coarsening rather than growing. With every table at
its cap the profile holds about 17 MB, nearly all of it the path table, and costs roughly
3% of an assessment.

The state is kept in process like the rest of the behavioural series, so across replicas
each sees its own share of the traffic. That understates every count here, and understating
costs a missed detection rather than an accusation.

### What the assessment carries

An `Assessment` exposes `marker`: the reading, the drift, and the identity shape. It is
there because the action path needs it to decide whether a response should carry a new
marker, and because it is genuinely useful to an operator looking at one request.

What leaves the machine is less than that. Notification sinks receive a **redacted** copy:
`redactEvent` runs on the way out and is on by default, and it drops `facts.cookies`,
strips the credential headers — `cookie`, `authorization`, `x-api-key` among them — masks
the address and the actor key to a `/24`, and masks query values. A marker is reduced the
same way: what a sink sees is whether one was presented, whether it verified, whether the
identity moved, and how many networks it has come from. The claims inside it, the marker id
included, do not go. They are the decoded contents of a cookie, and the rule about cookies
already covered them.

The unredacted assessment is what your own process holds — `handle()` returns it, and the
dashboard renders it for an operator who is already inside your perimeter. Turning
redaction off (`notifications: { redaction: false }`) is the one way to send more than the
above, and it is worth knowing what you are choosing when you do.

## What this deliberately does not do

**It does not link two clients by how alike they look.** Joining strangers on a shared
fingerprint and letting one's verdict raise the other's is guilt by association, and when
the link is wrong it denies a person for a stranger's behaviour. Every join here is the
same actor, or the same marker — something this server issued — and never a statistical
resemblance between two clients.

The site detectors are the one place evidence about *other* traffic reaches a verdict, and
they are shaped by that. Each one describes a pattern the client in front of you genuinely
took part in — it requested that path, it walked that range — rather than importing
somebody else's verdict, and each is capped where it cannot deny anybody alone.

**It does not build a profile.** The marker holds no identifier of a person, is not
readable across sites, and expires. Nothing here is retained to describe a visitor; it is
retained to describe a *series of requests*, and it ages out with the series.

**It does not reach `certain`.** Nothing on this page can. `certain` means no benign
explanation exists, and every signal here joins two requests — with the join itself being
the thing that could be wrong. A tampered marker comes closest and still stops at
`strong`, because a middlebox can mangle a cookie in transit and that is not the client's
fault.

## Related

- [Shadow mode](shadow-mode.md) — run any of these against your own traffic for a week
  before it is allowed to decide anything. Several of them fire at `moderate` on real
  people by design, and whether the thresholds are right *here* is not a thing this
  library can know.
- [Detectors](detectors.md) — the full catalogue and what each one is worth.
- [The client IP](../integration/client-ip.md) — why the actor key is what it is.
- [Writing a detector](writing-a-detector.md) — including what a detector may see.
