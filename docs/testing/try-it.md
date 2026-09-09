# Try it

A demo site with a live dashboard, eighteen scripted clients, and three dashboards
showing three different amounts of the same traffic.

← [Documentation](../index.md) · [Testing](index.md)

---

## The demo and the simulator

Two commands, two terminals:

```bash
npm run demo        # a protected site on :9673 + a live dashboard on :9674
npm run simulate    # points eighteen kinds of client at it
```

Open **http://localhost:9674/** and watch. Every request lands in the feed with its
verdict, its score, the action taken, and — click a row — the individual pieces of
evidence with their certainty tiers and, for proven ones, the written basis. The
second tab is the statistics panel: traffic over time, the latency histogram, and the
distributions behind the tiles.

That dashboard is not demo scaffolding. It is the one the library ships, started with
one call — `detector.serveDashboard({ port: 9674 })` — and you can put the same thing
in your own application. See [The dashboard](../operations/dashboard.md#the-dashboard).

The demo policy is deliberately overreaching: it asks to **block every suspected
bot**. Strict mode refuses every time. Those amber rows are the whole library in one
screen — requests scoring 93 and 98 that still do not get blocked, because a score is
not proof.

`npm run simulate` runs these, each from its own source address so they are distinct
actors, and prints what happened:

```
  human                 7x 200               2ms      unknown x7
  curl                  2x 429               1ms      confirmed-bot x2
  python                2x 429               1ms      confirmed-bot x2
  go                    1x 429               1ms      confirmed-bot
  scanner               3x 403               1ms      confirmed-bot x3
  headless              1x 429               1ms      confirmed-bot
  spoofed-browser       3x 429               1ms      suspected-bot x3
  platform-mismatch     1x 200               1ms      unknown
  fake-googlebot        1x 403               39ms     confirmed-bot
  verified-crawler      4x 200               2ms      verified-bot x4
  declared-crawler      30x 200, 6x 429      1ms      confirmed-bot x36
  trap                  1x 200, 1x 403       1ms      unknown, confirmed-bot
  trap-field            1x 403               2ms      confirmed-bot
  scraper               34x 429              1ms      suspected-bot x34
  metronome             14x 200              2ms      unknown x14
  burst                 30x 200              1ms      unknown x30
  credential-stuffing   8x 401               252ms    unknown x8
  no-user-agent         1x 200               1ms      unknown
```

Four rows are worth reading twice:

- **`human`** — seven ordinary page views, all served, verdict `unknown`. This is the
  row that matters. Every other row is only interesting if this one stays clean.
- **`verified-crawler`** — GPTBot arriving from the operator's published range is
  *allowed*, ahead of every other rule. Bot detection that costs you your search
  traffic has not helped.
- **`burst`** — thirty requests as fast as a socket allows, and all thirty are
  served. Rate is capped at `moderate` and cannot block on its own, because behind a
  corporate NAT that burst is a floor of people, not a bot — and the client's request
  carries the marks of a real browsing session, which discounts it further.
- **`credential-stuffing`** — served, `401`, and **253 ms each**. No challenge, no
  block, nothing excluded; the attack simply stops being economic.

The simulator speaks raw HTTP over a socket rather than using `fetch`, because
`fetch` normalises the header set and fixes the order — the exact properties several
detectors read. Run one scenario at a time with `npm run simulate:curl`,
`npm run simulate:trap`, and so on; `npm run simulate:list` prints them all.

### Replaying the whole corpus over the wire

```bash
npm run simulate:corpus                              # all 548 cases
npm run simulate:corpus:human                        # only the people
npm run simulate -- --corpus --tag known-cost        # only the awkward ones
npm run simulate -- --corpus --case browse-chrome-windows --verbose
```

```
  by audience
    human           178/178 pass   served 173, challenge 5
    benign-bot      137/137 pass   served 89, block 46, challenge 2
    unwanted-bot    104/104 pass   challenge 78, served 23, block 3
    declared-bot     29/ 29 pass   served 27, block 2
    infrastructure   33/ 33 pass   served 19, challenge 14
    hostile          19/ 19 pass   block 10, challenge 5, served 4

  500/500 replayed cases pass  ·  0 false positives
```

This is the stronger of the two tests. The in-process corpus runner calls `assess()`
directly; replaying the same cases down a socket exercises the **whole stack** — the
adapter, Node's header parsing, whether wire order survives into `rawHeaders`, cookie
parsing, and client-address resolution through the forwarding headers. A case that
passes in-process and fails on the wire has found an adapter bug, and one already did:
`exposeVerdictHeaders` turned out to be honoured on every response *except* the
challenge interstitial.

It also tells you where a check *cannot* apply on this runtime. A request carrying
both `Content-Length` and `Transfer-Encoding` is proven automation by RFC 9112 — and
Node's own parser answers it 400 before any handler runs, so that case reaches the
engine only when the facts were built somewhere Node's parser is not in the path: an
edge worker, a WAF event, a log line. The replay found that, and the case now says so
in its skip line rather than passing by accident.

Cases with no wire equivalent are skipped and counted rather than quietly passing —
HTTP/2 fixtures, cases that declare their own DNS answers, cases needing a clearance
token only the server can mint, cases the runtime refuses before detection, and cases
needing ranges the demo does not load.

---

**Start in monitor mode.** Run `preset: "monitor-only"` against real traffic for a
week before you enforce anything. It withholds nothing from anybody and shows you
exactly what your traffic looks like. Every bot policy that has caused an outage was
deployed straight to enforcement by someone confident they already knew.

---

## Role-gated dashboards

A second demo, for the question the first one does not answer: who is allowed to look?

```bash
npm run demo:roles
```

Four listeners this time — a protected site with an operator console on **:9683**, and
three dashboards over the same handler: an **analyst** view on **:9684**, an
**operator** view on **:9685** with the policy editor and the reset button, and an
**admin** view on **:9686** that can also change the guard.

Start at **http://localhost:9683/operator** and pick a role. There is no password, on
purpose: this demonstrates *authorisation* — what a proven identity may reach — and
the proving belongs to your identity provider. Signing in sets an HMAC-signed cookie
carrying the role, and `auth: { authorize }` reads it.

Then try the three dashboards as each role:

| | analyst `:9684` | operator `:9685` | admin `:9686` |
| --- | --- | --- | --- |
| anonymous | `401` | `401` | `401` |
| analyst | `200` | `401` | `401` |
| operator | `200` | `200` | `401` |
| admin | `200` | `200` | `200` |

As an analyst the other two answer `401` on *every* path — authentication runs before
routing, so a caller without the role cannot even map the endpoints. And on the analyst
dashboard the editor endpoint answers `403` even for an admin, because `controls`
belongs to the listener rather than to the visitor: a dashboard started without it has
no editor to reach, whoever is asking.

Each rung adds exactly one thing, and the last is the one to look at hardest. An
operator can write a rule that asks for more than the evidence supports, and the guard
stops it. The admin listener is the only one that can change *whether anything stops
it* — `controls.editGuard`, off by default and separate from `editPolicy` on purpose —
and the only one that can act on a single client: allowlist an address, forget an
actor's history, clear one as human (`controls.editRanges`).

Change any of it and watch the terminal. Every change prints with the name of whoever
made it, because this demo's `authorize` returns the signed-in email instead of `true`
— which is all the dashboard needs to attribute a change in the handler's warnings, in
the `guard-change`, `range-change` and `actor-change` events, and on the marker it
leaves on the traffic timeline.

The analyst listener also runs with `sections: { evidence: false, policy: false }` and
`redact: { maskIp: true }`. It has two tabs rather than three, its rows show what
happened without naming which detector fired, and the feed shows `203.0.113.0/24` where
the others show the address. Open devtools on it: the evidence is not hidden from the
page, it never reaches it. The dashboard people watch all day need not be the one that
names individuals, or the one that explains your detection to whoever is scraping you.

Read [the dashboard's Roles section](../operations/dashboard.md#roles) for what to change before
this goes anywhere real.

---

## Related

- [Testing](index.md) — the rest: the CLI, the corpus, log replay
- [The dashboard](../operations/dashboard.md) — every option the demo is showing you
- [The corpus](corpus.md) — the traffic the simulator is a live version of
