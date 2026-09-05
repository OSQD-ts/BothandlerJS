# The dashboard

The operator dashboard: what it shows, what it refuses to do, and every option it takes.

← [Documentation](../index.md) · [Operations](index.md)

---

Counters tell you *how much*. The dashboard tells you **which requests, and why** —
every assessment as it lands, and, on any row you open, the individual pieces of
evidence with their certainty tier and, for proven ones, the written basis.

```ts
const dashboard = await botHandler.serveDashboard({
  port: 9674,
  auth: { username: "ops", password: process.env.DASHBOARD_PASSWORD! },
});

console.log(dashboard.url);   // http://127.0.0.1:9674/
```

That is the whole integration. It listens on a port of its own, subscribes to the
handler you called it on, and returns a handle with the URL and a `close()`.

### Four screens

**Live feed** — one row per request: when it happened, method and path, the actor, the
User-Agent, the verdict, the score, the action and the rule that chose it. Filter by
proven, suspected, human, guard stops, denied, mitigated or served; or type into the
search box.

The search takes fields, and negation, because the two cases people actually reach for
it are an address that also appears inside a User-Agent and a path that is a prefix of
ten others:

```text
actor:203.0.113.4 -path:/health      that address, except its health checks
rule:no-scrapers action:tag          the rule that fired, and what it settled on
score:>70 -certain                   probabilistic traffic close to the line
"GET /api/v2/orders"                 a phrase, spaces and all
```

Fields: `path` `actor` `ua` `verdict` `action` `rule` `detector` `identity` `method`
`class` `id` `bypass` `outcome` `certain` `score`. Every term must match — narrowing
means `AND` — and anything that is not a field term is matched against the whole
request, so a plain word behaves as it always did. **The filter and the search are in
the URL**, along with the view, so a screen is a link rather than a set of
instructions, and a refresh keeps your place.

The rows are updated in place rather than redrawn. That is invisible until you try to
read a feed that is moving: a rebuilt row takes your text selection with it, so
copying a User-Agent out of a live feed used to be impossible without pressing Pause
first.

Open a row and you get the case for the verdict: every piece of evidence with its
tier, its family, and — for proven ones — the written basis; the **request headers in
wire order**, credentials replaced, which is what half the detectors are actually
reading; the query parameters, values masked; and any detector that failed. Three
buttons turn the row into something you can keep:

| | |
| --- | --- |
| **Copy replay line** | The request as a JSONL line for `bothandlerjs replay`. |
| **Copy corpus case** | The same request as a traffic-corpus fixture, ready to paste. |
| **Draft a rule** | Starts a rule from this request, in the policy editor. |
| **Show this actor** | Opens the drill-down. |

That first pair is the loop this library cares about: a verdict you disagree with on
screen becomes a fixture you re-run offline, and then a corpus case that stops it
coming back. **Export** in the toolbar is the same thing for the whole window at once
— every request matching the current filter, as replay JSONL.

**Draft a rule** is the other loop, the one that used to have no help at all: you saw
an actor worth acting on, then went to a different tab and hand-wrote a rule, guessing
at which field would catch it. It matches on the strongest thing the request actually
proves — a verified identity, else the detectors whose evidence was proven, else the
verdict with a score floor — and it does three things deliberately:

- **The action is always `tag`.** Never `block`, whatever the request looked like. A
  drafted rule has been reviewed by nobody, and the dashboard picking a terminal action
  for a request that annoyed you is the reflex this library exists to interrupt.
- **It goes last**, which is the only position that cannot change what an existing rule
  does. If it is shadowed, the preview says so as "never matched".
- **Nothing is applied.** It fills the editor and previews itself, exactly like an
  import.

Click any **actor** and the drill-down opens above the feed: what the engine knows
about them — requests in the window, distinct paths, prior confirmations, whether they
hold clearance, first seen, mean gap between requests — with their verdict and action
mix. It is the same picture `cadence` and `crawl-breadth` are reasoning about.

Beside the feed, **Test a request**: paste a User-Agent, a `curl` command out of
devtools, or a raw header block, and see the verdict, the evidence and the rule that
would fire — without waiting for that client to come back. It runs a **dry run** on the
server ([`assess(facts, { record: false })`](../detection/index.md#asking-about-a-request-that-is-not-happening)),
so nothing is recorded: no counter moves, no actor state changes, no row appears in the
feed it is sitting next to. It says what it had to assume, every time, including the one
that matters most — a dry run has no history, so what it answers is *what would this look
like as a first request*. Which is what a support ticket is asking anyway.

**Actors** — everyone the *registry* is holding, busiest first, which is a much larger
population than the feed's. The ring holds a few hundred requests; on a busy origin that
is a few seconds. The registry holds up to `maxActors` clients, each with the rate
series, path breadth and confirmation count that `cadence`, `crawl-breadth` and
`rate-anomaly` are reading — so "who is hitting me hardest right now" is a question only
this screen can answer. Requests, requests per minute, distinct paths, cadence
regularity (near zero is a metronome, which no person is), prior confirmations, and
whether they hold clearance. **In feed** sends one to the live feed as an `actor:` filter,
which makes it a shareable URL like every other view.

**Statistics** — a traffic timeline (1m/5m/15m/1h) split by outcome, which says how
much history the window actually holds rather than drawing a flat line through time it
never had; the assessment-latency histogram with mean, p95 and max; and the **score
distribution with your `suspectThreshold` marked on it**, which is the chart that
answers "how close does ordinary traffic run to the line?" before you move it.

That chart takes a scope, and the reason is worth stating: half this screen counts the
few hundred requests still in the feed's ring and half counts since the process
started. Those are different populations — on a busy server the ring can be ninety
seconds of a three-week run — and they used to wear the same grey subtitle. Every
window-scoped panel now says how much window there is ("last 500 requests · 4 min"),
and the score distribution defaults to **since start**, drawn from the same counters
the Prometheus endpoint exposes, with **this window** one click away.

Then the attribution: **guard stops broken down by the rule that overreached**, **rule
hit counts including the rules that never fire** (a rule matching nothing is either
dead configuration or a rule sitting behind a broader one, and both are invisible in a
chart that only draws what happened), identities seen split into verified and merely
claimed, busiest and most-denied paths, what bypassed detection and why, the challenge
funnel with its solve rate, detector failures, and every installed detector with its
firing count and — when timing is on — what it costs.

Beside them, the **audit panel**: the window against its baseline, measure by measure,
with the ratio between them and the checks that are installed. See
[The audit](audit.md).

**Policy** — the rules as JSON, the guard settings (read-only unless you opted in — see
[Changing the guard](#changing-the-guard-behind-its-own-flag)), a `robots.txt` preview
generated from the rules that decline crawlers, and the notices panel: startup
warnings, audit anomalies, and anything else the engine has raised, which otherwise
scroll past in a log nobody reads.

The counters come from the same `metrics()` snapshot as the Prometheus endpoint, so
the numbers on the screen and the numbers in your alerting agree by construction.

### Trying a policy before you mean it

The Policy screen previews a candidate rule set against the traffic still in the
window, and reports what would change:

```
44 of 151 requests would be treated differently.
43 request(s) that are served today would be denied. Read the samples before applying.
```

Any of the shipped presets can be previewed by name — "what would `protect-data` have
done to *my* traffic?" answered from your traffic rather than from the documentation —
and so can anything you type into the editor. It works because `decide()` is pure: a
candidate policy can be run over the window as many times as you like and nothing
about the running system moves.

Rule *matching* is exact — every field the matcher reads travels on the feed entry —
and so is the safety guard. What a preview cannot tell you is what the action would
have *done*: a challenge might have been solved, a rate limit might not have been
reached. It answers "which rule, and which action", which is what an edit is about.

### Live policy editing, behind a flag

```ts
await botHandler.serveDashboard({
  auth: { username: "ops", password: process.env.DASHBOARD_PASSWORD! },
  controls: { editPolicy: true },     // off by default
});
```

With it on, the Policy screen's editor can **apply** a rule set to the running handler.
The rules are validated first and swapped atomically, so a rejected edit leaves the
running policy exactly as it was, and every apply is announced through the handler's
`warning` event and the `policy-change` hook — it lands wherever your startup warnings
land, which is the audit trail this deserves.

The editor is a form, not a text box. Each rule is a row showing its position, its id,
what it matches and the action it asks for; open one and every field of the match is a
control — verdicts, classes, categories and detectors as toggles, evidence as
any/proven/unproven, score as a range, paths and identities as lists, and the action's
parameters appearing to suit whichever action you picked. The dropdowns are built from
the engine's own vocabularies and the detector ids actually installed on *that*
handler, so the editor cannot offer you a verdict the library does not have. **Order
is the semantics** — first match wins — so the rows move with ↑ and ↓ and are numbered.
A JSON view is one click away for anything faster to type than to click.

### Changing the guard, behind its own flag

```ts
await botHandler.serveDashboard({
  auth: { authorize: (req) => roleOf(req) === "admin" },
  controls: { editGuard: true },      // off by default, and separate from editPolicy
});
```

With it on, the Guard panel becomes a form: `falsePositivePolicy`, `fallbackAction`,
`defaultAction`, `terminalScoreThreshold` and `suspectThreshold`, applied to the
running handler.

**It is a separate flag from `editPolicy`, and that is the whole design.** They are
different powers. A rule editor can write a rule that overreaches, and the guard stops
it; the worst it can do is produce a downgrade. This changes the guard itself — whether
an unproven verdict may deny anybody at all — and the people it turns away first are
the ones with the most unusual and most legitimate setups. So a dashboard that hands
out the first does not thereby hand out the second, and you can put a different role in
front of each.

Everything else is the same contract the rule editor has. A change is validated before
anything moves, applied whole or not at all, previewed against real traffic first
("what would `balanced` have done to *my* traffic?" is a question the preview answers
from your window), and announced twice — through the handler's `warning` event, which
lands wherever your startup warnings land and in the notices panel, and as a
`guard-change` event carrying both the before and the after.

Two things stay impossible whatever the flag says, because both would leave the guard
switched on and doing nothing:

- **A terminal `fallbackAction`.** The fallback is what a downgraded decision *becomes*.
  Set it to `block` and every downgrade blocks — the exact outcome the downgrade exists
  to prevent — and the decision would still be recorded as a guard stop, so the metric
  that is supposed to catch this would report success.
- **A `terminalScoreThreshold` outside 1–100.** Zero would let balanced mode deny on
  any score at all.

The form says what each mode means where the choice is made, rather than in
documentation somebody would have to go and find, and Preview sits next to Apply. If
you turn this on, the reason should include who is allowed to press it — and
`guard-change` is the event to alert on.

### Acting on one client

```ts
await botHandler.serveDashboard({
  auth: { authorize: (req) => roleOf(req) === "admin" },
  controls: { editRanges: true },     // off by default
});
```

Three operations, on the actor drill-down and on every row of the Actors screen. They
share one flag because they are one job — acting on a specific client rather than on a
class of request — and because the first is consequential enough to carry the other two.

| | |
| --- | --- |
| **Allowlist** | Adds the address to the `allowlist` range set. Asks twice, and the second button says the address it is about to exempt. |
| **Forget** | Discards that actor's behavioural memory. |
| **Clear as human** | Grants clearance for an hour, as though a challenge had been solved. |

**An allowlisted address is not judged leniently — it is not judged at all.** Detection
does not run on it, no evidence is produced, no rule sees it. That is the right answer
for your own monitoring and the wrong answer for anything that might one day be somebody
else's, which is why the button states the address and waits for a second click rather
than putting up a dialog: a confirmation you can dismiss without reading is a click with
extra steps.

**Forget** is the mild one and the reason the flag exists at all. A person whose actor
key collected a `confirmed-bot` — a shared office address, a phone that reused an IP —
carries `priorConfirmations` for the rest of the window, and every rule reading
`minPriorConfirmations` keeps matching them. Until this existed the only cure was Reset,
which throws away every actor's history to fix one person's. It is not an allowlist: the
next request from that actor is assessed exactly as any first request would be.

The **Range sets** panel on the Policy screen shows what is actually in each set rather
than how many entries it has, and adds or removes one at a time. It is read-only without
the flag.

Unavailable when `redact.maskIp` is on, and that is not a UI decision: a masked key names
a `/24` while the registry is keyed by the address, so the buttons would act on the wrong
key. The whole control goes rather than half of it.

### Who did it

The dashboard has no user model — `authorize` answers one question, and roles are yours.
But an audit trail that can say the guard was changed and cannot say by whom is half an
audit trail, so the check may name the viewer:

```ts
auth: { authorize: (req) => sessionFrom(req)?.email ?? false }
```

Anything truthy admits them; a **string** additionally says who they are, and that name
travels into the `warning` the handler raises, into `policy-change`, `guard-change`,
`range-change` and `actor-change`, and into the marker this change leaves on the traffic
timeline. Basic auth supplies it without being asked, since a basic credential names
itself. A bearer token names nobody, and inventing a name would be worse than admitting
the gap. An empty string is a refusal rather than an anonymous admission, so a lookup
returning `""` for "no such user" fails closed.

### Sections: what a listener shows

`controls` says what a viewer may **do**. `sections` says what a viewer may **see**.
Everything defaults to on; turning something off removes it from the page *and* from
the server — the tab is gone, the panel is gone, the endpoint behind it answers `403`,
and the fields it would have shown are dropped before they leave the process. A viewer
with devtools open sees exactly what the page sees.

```ts
await botHandler.serveDashboard({
  port: 9684,
  auth: { authorize: (req) => roleOf(req) === "analyst" },
  sections: { evidence: false, policy: false },
  redact: { maskIp: true },
});
```

| Section | Off means |
| ------- | --------- |
| `feed` | No Live tab; `/api/feed` and `/api/stream` answer 403. |
| `evidence` | No evidence list, headers, query parameters, detector failures, replay or corpus export — and none of it on the wire either. |
| `actors` | No actor drill-down, no busiest-actors panel, and `actorStats` blanked on every entry. Takes `registry` with it. |
| `registry` | No Actors screen; `/api/actors` answers 403. |
| `tester` | No request tester; `/api/test` answers 403. |
| `statistics` | No Statistics tab and no counter tiles; the snapshot carries no `metrics`. |
| `audit` | No audit panel. |
| `notices` | No notices panel. |
| `changes` | No changes panel — the runtime audit list. The timeline markers go with it. |
| `policy` | No Policy tab; `/api/policy`, `/api/settings`, the preview and the editor all answer 403. Takes `guard` and `robots` with it. |
| `guard` | No guard panel, and `/api/guard` answers 403. |
| `ranges` | No range sets panel, and `/api/ranges` answers 403 — which takes the allowlist button with it. |
| `robots` | No `robots.txt` preview. |

`evidence` is the one to think about before sharing a dashboard widely. It is the half
of the page that says *which detector fired and why*, which is exactly what somebody
building a scraper against you needs in order to know what to fix next. Switching it
off leaves the feed — what happened, to whom, and what was done about it — which is
usually what a wider audience actually wants.

### Export and import

**Export** downloads the whole settings document: the rules, plus a record of the
guard, the thresholds, the installed detectors, the range sets, the audit checks and
the dashboard's own controls. It is the file you want when comparing two deployments
six months from now.

**Import** takes that file back — or a bare array of rules — by button or by dropping
it on the editor. It loads into the editor and applies *nothing*: an import that took
effect on drop would be a policy change made by a mis-drag. Review it, preview it
against real traffic, then apply.

Only the rules half is importable, and the file says so. The guard, the detectors and
the ranges come from the code that constructed the handler; a settings file that
appeared to carry them would be promising something it cannot deliver.

What it deliberately cannot do:

- **Relax the guard.** `falsePositivePolicy`, `fallbackAction`, `defaultAction` and
  `terminalScoreThreshold` are not read from the submitted document, and `editPolicy`
  confers no power over them. Write `action: "block"` on a probabilistic rule through
  the editor and the guard downgrades it exactly as it would have downgraded it in your
  config file. Changing the guard is a *different* permission with a different flag and
  a different endpoint — see below — and it is off unless somebody turned it on.
- **Delete a rule it cannot see.** A rule whose `match` is a predicate function cannot
  be serialised; those are shown read-only and spliced back into their original
  positions on save. Order is the whole semantics of a first-match policy.
- **Exist unauthenticated on a public address.** `editPolicy` with `auth: false` on a
  non-loopback bind is refused at startup: that combination is not a feature, it is a
  stranger's bot policy.

Leave it off in production unless you have a reason, and the reason should include who
is allowed to press it.

### Reconnecting costs a handful of frames

Every frame a viewer can miss carries an id, and `EventSource` hands the last one it
saw back as `Last-Event-ID` when it reconnects, unasked. So a laptop lid, a proxy
timing out an idle stream or a five-second blip costs the frames that were actually
missed — not the whole ring, which is five hundred entries with their headers, evidence
and actor history attached, per viewer, per blip. A cursor the server cannot honour
(a restarted process, a cleared feed, a gap longer than the ring) gets the backlog and
an instruction to replace what the page is holding, because leaving a viewer with rows
nothing will ever correct is worse than resending.

Pressing **Reset** tells every viewer, not just the browser that pressed it.

A busy origin is a firehose — every assessment to every open browser — so the stream is
capped at `maxEventsPerSecond` (100 by default, `0` to remove it). What is capped is the
*stream*: the ring keeps everything, so the preview, the export and anyone reconnecting
still see every request, and the feed says how many were not streamed. A thinned feed
must never look like a quiet one.

**A viewer that stops reading is not allowed to cost you memory.** A socket that has
stopped draining — a laptop that slept with the tab open, a phone in a tunnel, a proxy
that stopped reading — used to accumulate frames in this process, one queue per viewer,
without limit; the rate cap does not help, because that bounds a rate and this is a
backlog. A stream that reports itself full now stops being sent feed entries until it
drains, the skipped frames are counted, and the viewer is told the count when it catches
up. One that never drains is ended after twenty seconds, and the browser reconnects and
resumes from its cursor — which is what makes dropping it safe.

### What somebody did, on the same axis as what happened

Every runtime change — a policy applied, the guard moved, a range set edited, an actor
forgotten — leaves a marker on the traffic timeline, with the time, what changed and who
asked for it. That is what turns a preview from a prediction into something you can
check: *"44 of 151 requests would be treated differently"* is a claim, and a line on the
chart at the moment it was applied, with the traffic either side of it, is the answer.

### Reachable without a mouse, and without a screen

The tab strip honours the keyboard contract its `role="tablist"` promises: arrow keys,
Home/End, one stop in the tab order. Every feed row's method-and-path is a real
disclosure button — the row used to *be* the button, with the actor link inside it,
which is a control nested in a control and leaves a screen reader with two things to
announce and no way to say which one `Enter` belongs to. Clicking anywhere in the row
still opens it, because a click is a convenience rather than a contract.

Each chart carries its data in words. `role="img"` with a name says a picture is here
and what it is called; it says nothing about what is *in* it, so every number on the
Statistics screen used to be unreachable to a reader who cannot see the bars. The
traffic chart, the score distribution and the latency histogram now each have a
description naming their totals, their bands and — for traffic — the runtime changes
marked on them.

`npm run test:browser` runs axe against all four screens on every change and fails on
anything it rates serious or critical. It is what found the two defects above.

### One dashboard, one process — and the others

`peers` puts the sibling instances in the header:

```ts
peers: [
  { label: "web-1", href: "https://web-1.internal:9674/" },
  { label: "web-2", href: "https://web-2.internal:9674/" },
],
```

That is the honest amount of help this page can give with a fleet: a way to reach the
other ones. It aggregates nothing, deliberately. A feed and an actor registry summed
across pods would be a different tool with a shared store behind it, and the counters —
the part of this that genuinely wants aggregating — already go to Prometheus, which is
a thing your monitoring does better than a page could.

### It reports on one process

**This is the boundary most likely to mislead you.** A dashboard subscribes to the
handler in *its own process*. Behind a load balancer with eight pods there are eight
rings, eight sets of counters and eight actor registries, and the one you have open is
showing you an eighth of your traffic — including its Actors screen, its rate limits and
its allowlist edits, which land on that instance and nowhere else.

The header names the instance (`instance`, defaulting to the hostname) so a partial
picture does not look like a whole one. Aggregating across a fleet would mean a shared
store and a different tool; what this is for is looking at one process closely.

The feed is memory-only, too: a bounded ring of the last `feedLimit` requests, gone when
the process restarts. "What happened last night" is not a question it can answer — send
`onAssessment` or a [notification sink](notifications.md) somewhere durable
for that.

### Mounting it on a server you already have

```ts
import { createDashboardHandler } from "@osqd/bothandlerjs";

const dashboard = createDashboardHandler(botHandler, {
  basePath: "/_bots",
  auth: { authorize: (req) => sessionFrom(req)?.email ?? false },
  allowedClients: ["10.0.0.0/8"],
});

https.createServer(tls, (req, res) => {
  if (req.url?.startsWith("/_bots")) return dashboard(req, res);
  return app(req, res);
}).listen(443);
```

`startDashboard` opens a plain HTTP listener of its own. That is right on a laptop and
wrong in a lot of production networks: the certificate lives at an ingress, everything
has to be reachable under one hostname, or the platform exposes exactly one port.
`createDashboardHandler` is the same dashboard without the socket — a `(request,
response)` function you can mount wherever you already terminate TLS.

Two things differ, and both follow from not owning the socket:

- **`auth` is required**, including the explicit `auth: false`. The listening form may
  skip it on `127.0.0.1` because the operating system is then the access control; here
  there is no bind address to inspect, so nothing can be assumed and what is assumed is
  "public". Same for the editors: `editPolicy`, `editGuard` and `editRanges` with
  `auth: false` are refused, exactly as they are on a public bind.
- **`close()` does not close a server it does not own.** It unsubscribes from the
  engine, ends every event stream and stops the timers. Your server is yours.

`basePath` is the path the page is served under, because that is what the page needs in
order to build its own URLs. Routing accepts the path with or without that prefix, so it
works whether or not your framework strips the mount point first — `app.use("/_bots",
dashboard)` in Express and a bare `if (url.startsWith("/_bots"))` both do the right
thing. The `Host` check is enforced only if you pass `allowedHosts`, since the server
that owns the socket is the thing that knows which names reach it.

What this does *not* change is the reason the dashboard is separate from the application
it reports on: **mount it on a server that does not run your bot handler.** Serving it
from inside the application means reading the dashboard shows up in the dashboard, and a
challenge served to your site can lock you out of the tool you are using to read about
it. `examples/dashboard-mounted.ts` is the whole arrangement in one file.

### Its own listener, and why

The dashboard never mounts inside the application it reports on. That arrangement has
three separate failure modes: reading the dashboard shows up in the dashboard, a
challenge served to your site can lock you out of the tool you are using to read about
it, and the page inherits whatever authentication your public site happens to have. A
second port costs nothing and avoids all three.

### It refuses to start in an unsafe configuration

The page lists client addresses and names the exact signal that fired on each request.
That is a *tuning guide for whoever is scraping you*: it tells them which check to fix
next. So the defaults are cautious and the unsafe combinations do not start at all.

```ts
await botHandler.serveDashboard({ host: "0.0.0.0" });
// ConfigError: … publishes it beyond this machine, and no `auth` was configured.
//              Configure auth: { username, password }, auth: { token } or
//              auth: { authorize }; keep the default host: "127.0.0.1";
//              or write auth: false to state that something in front of it
//              already authenticates.
```

| | |
| --- | --- |
| **Binds loopback** | `host` defaults to `127.0.0.1`. Anything else needs an explicit `auth`, including the explicit `auth: false`. |
| **Credentials compared in constant time** | Both halves of a basic credential, and the whole of a token. A wrong username is indistinguishable from a wrong password. |
| **Authentication before routing** | An unauthenticated probe gets `401` for every path, so it cannot even map the endpoints. |
| **Writes must come from this page** | `Sec-Fetch-Site` must say `same-origin` or `none`, `Origin` (when there is no fetch metadata) must name this server, and a body must be `application/json` — which an HTML form cannot send. Credentials cannot decide this: a browser attaches them to somebody else's forged form as willingly as to a real request. Clients with no browser provenance at all — curl, a deploy script — still work. |
| **Answers only to names you wrote down** | On loopback the `Host` header must be `localhost`, `127.0.0.1`, `[::1]` or something in `allowedHosts`; anything else gets `421`. This is the lock on DNS rebinding, where a name the attacker owns resolves to `127.0.0.1` and every check above agrees it is same-origin. |
| **Reset is off** | Clearing the actor registry discards real state — rate series, cadence, clearances. Opt in with `controls: { reset: true }`. |
| **The editor is off** | And when on, it can change which rules exist and nothing about how far one may go. `controls: { editPolicy: true }`. |
| **A wrong password is slowed down** | Five failures from an address and the next attempt is refused for a delay that doubles each time, up to five minutes. A success clears it. Under a silent `refusal` the lockout is silent too, because a `429` would confirm there is a credential here worth guessing. |
| **Acting on a client is off** | `controls: { editRanges: true }`, refused unauthenticated on a public bind and unavailable under `redact.maskIp`. |
| **The guard editor is off, separately** | `controls: { editGuard: true }` is a different flag for a different power, refused unauthenticated on a public bind like the other one. A terminal `fallbackAction` is refused whatever it is set to. |
| **Strict CSP, fresh nonce per response** | `default-src 'none'`, no remote script, style, font or image, `frame-ancestors 'none'`, `no-store`. |
| **No `innerHTML`, anywhere** | Every value on the page — User-Agents, paths, evidence summaries — is client-written text, and reaches the document through `textContent`. A test asserts the string never appears. |

### Options

| Option | Default | |
| ------ | ------- | --- |
| `port` | `9674` | `0` binds an ephemeral port; read the real one back from `dashboard.port`. |
| `host` | `"127.0.0.1"` | See above. |
| `auth` | none on loopback | `{ username, password }`, `{ token }`, `{ authorize(req) }`, or `false`. |
| `basePath` | `"/"` | Mount under a prefix, e.g. `"/_bots"`. |
| `title` / `links` | `"bothandlerjs"` | Header name, and links back to your site or runbook. |
| `feedLimit` | `500` | Requests kept in the ring, capped at 5000. |
| `maxClients` | `16` | Concurrent viewers; beyond it the stream answers `503`. |
| `maxEventsPerSecond` | `100` | Entries per second pushed to each viewer; `0` removes the cap. The surplus stays in the window and the page says how much it was. |
| `feedTtlMs` | `3600000` | How long a request may stay in the feed. A retention promise, where `feedLimit` is a capacity bound; `0` keeps them until the ring evicts them. |
| `allowedClients` | none | Addresses or CIDRs that may reach this dashboard at all, checked before authentication. A layer on top of `auth`, not a replacement. |
| `authThrottle` | on | Backoff after repeated failed credentials, per address: `{ maxAttempts: 5, lockoutMs: 1000, maxLockoutMs: 300000 }`, or `false`. |
| `peers` | none | Sibling instances, as `{ label, href }`, offered in the header. Aggregates nothing; see below. |
| `instance` | hostname | Which process this is, shown in the header. See below. |
| `controls.reset` | `false` | Enables the Reset button. |
| `controls.editPolicy` | `false` | Enables applying rule changes to the running handler. See above. |
| `controls.editGuard` | `false` | Enables changing the guard on the running handler. Separate from `editPolicy` on purpose. See above. |
| `controls.editRanges` | `false` | Enables allowlisting an address, forgetting an actor, and granting clearance. Unavailable under `redact.maskIp`. See above. |
| `sections` | all on | Which parts of the page this listener has, enforced on the server as well as the page. See above. |
| `basePath` | `"/"` | Also what a mounted dashboard tells the page it is served under. |
| `refusal` | `"unauthorized"` | What a caller this dashboard will not serve is told: `"unauthorized"` (401), `"not-found"` (404, identical to an unknown path), `"close"` (drop the connection), or `{ redirect, status? }`. See below. |
| `allowedHosts` | loopback names | Extra `Host` values a loopback dashboard answers to, for reaching it through a name of your own — an SSH tunnel aliased in `/etc/hosts`, say. `"*"` turns the check off. Ignored on a public bind. |
| `redact.maskIp` | `false` | Show `203.0.113.0/24` instead of the address. Turn it on when the dashboard is shared more widely than your logs. |
| `redact.truncateUserAgent` | `false` | Keep only the first 48 characters. |
| `redact.maskQuery` | `true` | Show query parameter names, not values. Reset tokens live in query strings. |
| `redact.headers` | `true` | Show the request headers in the row detail. Credentials are always stripped. |
| `exposePrometheus` | `false` | Serves `<basePath>/metrics` behind the same auth. |

`{ token }` is also accepted as `?token=…` so a link can be opened directly — which
puts the secret in browser history and in every proxy log on the way. Fine for a
laptop; use the `Authorization` header anywhere else.

### Behind your own gateway

`auth: { authorize }` receives the raw `IncomingMessage`, so a header your gateway
sets, a session cookie, or an mTLS subject all work. A check that throws is a check
that failed — never an open door.

```ts
await botHandler.serveDashboard({
  host: "0.0.0.0",                       // behind an authenticating proxy
  auth: { authorize: (req) => req.headers["x-forwarded-user"] !== undefined },
  redact: { maskIp: true },
});
```

### Getting around it

| | |
| --- | --- |
| `1` `2` `3` `4` | Live feed, Actors, Statistics, Policy — indexing the tabs this listener actually has |
| `Tab` into a row | Each row's method-and-path is its disclosure button; `Enter` or `Space` opens the evidence |
| `←` `→` `Home` `End` | Move along the tab strip |
| `/` | Jump to the filter |
| `Enter` / `Space` | Open the focused request's evidence |
| `Escape` | Clear the filter, then close what is open |
| `Tab` | The first stop is a skip link past the header |

The view is in the URL, so `…:9674/#policy` opens on the policy screen, the back
button moves between views rather than leaving the page, and a refresh — the reflex
when a live feed looks stuck — keeps your place.

### Saying less to a stranger

`401` is honest, and honest is usually right: someone who mistyped a password needs to
read that. It also confirms, to anyone sweeping a port range, that this address runs an
administrative page worth returning to. `refusal` decides which of those matters more
to you.

```ts
await botHandler.serveDashboard({
  auth: { token: process.env.DASHBOARD_TOKEN! },
  refusal: "not-found",     // a probe sees a server that has never heard of this path
});
```

| | What a refused caller gets |
| --- | --- |
| `"unauthorized"` | `401`, with `WWW-Authenticate` under basic auth. The default. |
| `"not-found"` | `404`, byte-identical to the answer for a path that does not exist here. |
| `"close"` | Nothing. The connection is destroyed, the way a dropping firewall behaves. |
| `{ redirect, status? }` | `302` (or `303`/`307`/`308`) to wherever you send people to sign in. |

Anything other than the default also **collapses the three pre-routing refusals into
one answer** — a failed `auth`, a `Host` outside `allowedHosts`, a cross-site write.
That is the property that makes concealment worth anything: a probe that can tell
"wrong host" from "wrong password" has just learned a password exists. Under the
default they keep their distinct statuses (`401`, `421`, `403`) on purpose, because the
likelier reader is an operator debugging their own deployment and three statuses are
three diagnoses.

Two things to be clear about.

**This is concealment, not access control.** A dashboard answering `404` to the wrong
credentials is exactly as reachable by someone holding the right ones, and exactly as
exposed if those leak. It raises the cost of *finding*, which is worth something
against indiscriminate scanning and close to nothing against somebody who already knows
where to look. It is a layer on top of `auth`, never a replacement for it.

**A silent refusal and basic auth cannot both work.** A browser prompts for a password
because a `401` asked it to; answer `404` and no prompt ever appears, so the credential
the server is waiting for can never be typed. That combination is refused at startup
rather than at the moment somebody needs the page — use `{ token }` or `{ authorize }`
with a link people already hold. A redirect is fine alongside basic auth, since a
prompt is still reachable at the other end.

### Roles

`authorize` is deliberately a *binary* question — may this request touch the dashboard
at all? There is no role model in here, no user table, no session store, because every
one of those already exists in your application and a second copy that disagrees with
the first is worse than none. What you supply is a predicate; what it reads is up to
you.

That gets you "only admins may open it" in one line:

```ts
auth: { authorize: (req) => sessionFrom(req)?.role === "admin" }
```

Two roles with *different powers* — or different **views** — is a second listener
rather than a cleverer predicate, because `controls` and `sections` are fixed when the
listener starts and not evaluated per request. That is the trade deliberately: no
per-request role evaluation, no session store in here, no second copy of your user
table to disagree with the first. You bring the roles; each listener is the surface one
role gets.

```ts
// Analysts look, and not at everything. `controls` is absent, so the server answers
// 403 to the editor and the reset endpoint — not a hidden button, a closed door — and
// `sections` takes the evidence and the policy off this listener entirely.
const viewer = await botHandler.serveDashboard({
  port: 9684,
  auth: { authorize: (req) => ["analyst", "admin"].includes(sessionFrom(req)?.role) },
  sections: { evidence: false, policy: false },
  redact: { maskIp: true },
});

// Operators tune the rules. The guard is still fixed for them.
const operator = await botHandler.serveDashboard({
  port: 9685,
  auth: { authorize: (req) => ["operator", "admin"].includes(sessionFrom(req)?.role) },
  controls: { editPolicy: true, reset: true },
});

// Admins can also change what a rule is allowed to do.
const admin = await botHandler.serveDashboard({
  port: 9686,
  auth: { authorize: (req) => sessionFrom(req)?.role === "admin" },
  controls: { editPolicy: true, editGuard: true, reset: true },
});
```

`serveDashboard` keeps no singleton state, so all three stay live against the same
engine, each reporting on it and each with its own surface.

`npm run demo:roles` is this, working, with a signed session cookie and an operator
console to pick a role at — see [Try it](../testing/try-it.md#role-gated-dashboards).

Three things that demo exists to show you before you build it yourself:

- **A custom `authorize` sends no `WWW-Authenticate`,** so the browser puts up no login
  prompt. The 401 is bare, and it is bare on every path, since authentication runs
  before routing. Send people to your own sign-in page; do not expect the browser to.
- **Cookies are scoped by host, not by origin.** One sign-in on `localhost:9683`
  covers `:9684` and `:9685` because the port is not part of a cookie's identity.
  Convenient on a laptop, and the reason a stray service on the same host can read a
  session cookie your app set.
- **A session cookie is not what stops a forged write.** The browser attaches it to a
  cross-site request as willingly as to a real one, which is why the dashboard checks
  `Sec-Fetch-Site` and insists on a JSON body independently of who you are.

The demo runs exactly this dashboard — `npm run demo` calls `serveDashboard()` — so
what you see at `localhost:9674` is what you get in your own application.

---

## Related

- [Operations](index.md) — events, metrics, the audit
- [Runtime changes](runtime-changes.md) — what the editor and the guard panel actually call
- [Try it](../testing/try-it.md) — the demo, including the role-gated dashboards

