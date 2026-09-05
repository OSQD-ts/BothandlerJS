# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.0]

### Security

- **The dashboard accepted state-changing requests from other people's pages.**
  `POST /api/policy/apply` and `POST /api/reset` checked credentials and nothing
  else, and a browser attaches credentials to a cross-site request as willingly
  as to a real one. Because `text/plain` is a CORS "simple request", a plain HTML
  form on any page an operator visited could swap the running bot policy — to
  `monitor-only`, disabling blocking site-wide — or wipe the actor registry,
  with no preflight and no warning. Three locks now, checked independently:

  - `Sec-Fetch-Site` must be `same-origin` or `none` when the browser sends it,
    and `Origin`, when present without it, must name this same server. Requests
    with no browser provenance at all — curl, a deploy script — still pass.
  - Request bodies must be `application/json`. An HTML form cannot send that
    media type, and anything that can must ask permission first through a
    preflight this server answers for nobody.
  - Reads are deliberately untouched: no `Access-Control-Allow-Origin` is sent,
    so a cross-origin reader never sees the response it fetched.

- **The dashboard answered to any `Host`, which left DNS rebinding open.** A
  name the attacker controls, pointed at 127.0.0.1, is *same-origin* by the
  browser's reckoning, so every check above agrees with it. On a loopback bind
  the `Host` header is now checked against the names a dashboard is actually
  opened under (`localhost`, `127.0.0.1`, `[::1]`) plus anything listed in the
  new `allowedHosts` option; unrecognised names get a 421. A public bind is
  unaffected — rebinding wins nothing against an address the attacker can reach
  directly, and enforcing a list there would break every reverse proxy.

- **`X-Forwarded-For` was believed even from a peer that is not one of your
  proxies.** With `trustedProxies` configured, the header chain was walked but
  the connecting peer never was, so a request that reached the origin *without*
  passing through the load balancer — a leaked origin address, a directly
  reachable pod — could name its own client IP, and with it its own actor key,
  rate-limit bucket and IP reputation. The peer is now the first hop and is
  checked like any other: a request from outside the trusted ranges falls back
  to the socket address. This is what `proxy-addr` has always done and what
  `trustedProxies` was there to promise.

### Fixed

- **The fetch adapter did not fail open.** An error inside the engine escaped
  `createFetchAdapter` to the runtime, and Workers, Deno and Bun all answer 500
  — a detection bug charged to the visitor, which is the one thing every
  adapter's doc comment promises not to do. It now reports through `onError` and
  serves the request, as the node, Koa and Fastify adapters already did.

- **123 build-tool packages were declared as runtime dependencies.** `vite`,
  `rollup`, `esbuild`, `chai`, `express` and the rest of the flattened dev tree
  were listed under `dependencies`, so `npm install @osqd/bothandlerjs` pulled roughly
  134 MB into somebody else's project and handed them an esbuild advisory
  (GHSA-g7r4-m6w7-qqqr) as a *production* vulnerability in a library that does
  not use esbuild. The library imports nothing but `node:` builtins; the
  dependency list now says so, and CI fails if that stops being true.

### Added

- **`minUnsolvedChallenges` — a rule that reads challenges nobody answered.**
  `ActorState.unsolvedChallenges` was declared and never written or read; it counts now,
  rising with each challenge issued and clearing the moment one is solved. Outstanding
  rather than cumulative, so it never accumulates against somebody who came back and
  proved it.

  A rule rather than evidence, on purpose. One abandoned challenge is a person — a slow
  phone, a lost tab, a change of mind — and only repetition means anything, which is a
  judgement about traffic the library cannot see. The engine counts; your policy decides.
  Shown on the Actors screen and offered in the dashboard's rule editor.

- **The challenge interstitial can be written in the visitor's language.**
  `challenge.translations`, keyed by language tag, chosen from `Accept-Language` with
  `q` honoured and a region falling back to its primary tag — and the document's `lang`
  attribute set to match, which is what decides the voice a screen reader reads it in.

  This is the only page the library shows to a member of the public, and they see it
  because a *probabilistic* verdict went against them: somebody who cannot read it
  cannot find the contact link on it either. The library ships no translations and will
  not — a machine-translated apology on a page that just turned somebody away is worse
  than an honest English one.

- **A performance ratchet, in CI.** There was a coverage ratchet and nothing guarding the
  hot path — the code every user of this library runs on every request — so a detector
  that got ten times slower would have shipped in silence. `npm run bench:guard` budgets
  `assess`, `handle` and `createFacts` as **ratios against a reference loop measured in
  the same process**, because a baseline in microseconds is a statement about the machine
  that produced it and fails on a CI runner for reasons unrelated to the code.

- **Published crawler ranges — `startCrawlerRangeRefresh()`.** Twelve shipped signatures
  verify by address rather than by reverse DNS, every AI crawler among them, and nothing
  in the library ever filled those ranges in: `updateCrawlerRanges()` was a method
  waiting for a caller. The library still ships **no address data** — a range baked into
  a release is wrong by the time somebody installs it — it ships the URL each operator
  publishes, so the answer comes from the party entitled to give it.

  Opt-in, because it makes outbound requests. Fails open per source: a publisher that is
  down, has moved its file or serves something unrecognisable leaves every other
  crawler's ranges as they were and that crawler's ranges as they were too. Two things
  are refused outright, because these ranges do not describe a crawler but **verify**
  one: a list containing a block bigger than any crawler owns, and an empty list.

- **`shareConfirmations` — proof crosses replicas; suspicion does not.** Behavioural
  state is process-local by design, because a round trip per request would buy accuracy
  for signals that may only raise suspicion. A confirmation is not one of those:
  `confirmed-bot` is a *proven* verdict, and without sharing it a client proven to be a
  bot on one replica was a stranger to the other seven — so `minPriorConfirmations: 1`
  fired about an eighth as often as it read. The cost is one store read the first time
  each instance sees an actor, never awaited, so nothing joins the request path.

- **An audit check for the challenge solve rate.** The audit watched bot share, traffic,
  denials, guard stops, human share and detector failures — and not the one number that
  says *you are challenging people*. A proof-of-work challenge is trivial for a browser
  and trivial for a competent scraper; what it costs is a few seconds of somebody's
  afternoon. So a solve rate near one does not mean the challenges are working, it means
  they are mostly landing on people — and from every other angle a solved challenge
  looks like a challenge that worked, which is why it needed saying. `AuditWindow` gains
  `challengesSolved` and `challengeSolveRate`.

- **`bothandlerjs check` — your policy against 526 shapes of real traffic.** The question
  the library is organised around, asked offline and before a deploy: *if I point this
  configuration at the actual internet, who gets hurt?* It exits non-zero if any case
  marked `human` is denied service, which is what makes it a CI step rather than a
  report. DNS is controlled and the clock is manual, so it is reproducible and offline.

- **The corpus is a published entry point — `@osqd/bothandlerjs/corpus`.** Its own schema has
  always said "point the runner at *your* `BotHandler`", and until now only this
  repository could. It is a separate entry, so importing the library never loads a case
  of it.

- **`bothandlerjs explain`** — the dashboard's request tester as a command. A User-Agent,
  a `curl` command or a header block in; the verdict, the rule and every piece of
  evidence out, as a dry run that records nothing.

- **Hono and Next.js, in an example and in tests.** Neither needs an adapter — both speak
  `Request` and `Response`, which is what `createFetchAdapter` takes — but "it probably
  works with X" is how a framework ends up unsupported by accident.

- `BotHandler.warn()` is public, so an adapter or the range refresher can raise a warning
  through the handler's own channel.

- **`createDashboardHandler()` — the dashboard as a request handler, for a server you
  already have.** `startDashboard` opens a plain HTTP listener of its own, which is
  right on a laptop and wrong in most production networks: the certificate lives at an
  ingress, everything has to be reachable under one hostname, or the platform exposes
  exactly one port. This is the same dashboard without the socket, and `startDashboard`
  is now a thin wrapper over it.

  `auth` is required in this form, including the explicit `auth: false`: the listening
  form may skip it on `127.0.0.1` because the operating system is then the access
  control, and mounted there is no bind address to inspect, so nothing can be assumed.
  `close()` unsubscribes and ends the streams without closing a server it does not own.
  Routing accepts the path with or without `basePath` in front of it, so it works
  whether or not the surrounding router strips the mount point. See
  `examples/dashboard-mounted.ts`.

- **A wrong password is now slowed down.** Both halves of a basic credential were
  compared in constant time, which defeats a timing attack and does nothing about the
  obvious one — trying again. After five failures from an address the next attempt is
  refused for a delay that doubles each time, up to five minutes; a success clears it.
  Configured with `authThrottle`, and silent under a silent `refusal`, because a `429`
  would tell a prober there is a credential here worth guessing.

- **`allowedClients` — which addresses may reach the dashboard at all.** The layer
  `allowedHosts` is not: that checks the name in the `Host` header, this checks who is
  connecting. It is what "bind `0.0.0.0`, but only the VPN can reach it" means, it is
  checked before authentication, and it is a layer on top of `auth` rather than a
  replacement — an address is not a person.

- **`feedTtlMs` — how long a request may stay in the feed. Default one hour.**
  `feedLimit` is a capacity bound and this is a retention promise, which is a different
  question: on a quiet service five hundred requests can be a fortnight, and every entry
  holds somebody's address, User-Agent and header set. Eviction runs on the dashboard's
  own timer as well as on arrival, so it holds on an idle process — the only kind where
  it matters.

- **A Changes panel**, listing what was applied at runtime, when and by whom — the same
  list the traffic timeline marks, written out, because a marker answers "was there a
  change here?" and an audit wants "what were they, in order". `sections.changes`.

- **`peers` — sibling instances in the header.** The honest amount of help a page can
  give with a fleet: a way to reach the other ones. It aggregates nothing, and the
  counters that genuinely want aggregating already go to Prometheus.

- **Text alternatives for all three charts.** `role="img"` with a name says a picture is
  here and what it is called, and nothing about what is in it — so every number on the
  Statistics screen was unreachable to a reader who cannot see the bars. Each chart now
  carries its totals, its bands and its markers in words.

- **An axe pass over all four screens, in both themes, at two widths**, failing on
  anything it reports at any severity; a contrast matrix that measures every ink the page
  can paint against every surface it can appear on; and a test that drives the dashboard
  under sustained load and asserts every structure it owns stays bounded.

- **The challenge interstitial is in the browser suite too.** It is the only page in this
  library a member of the public sees — somebody who was going about their day and
  tripped a probabilistic verdict — so it is now audited in both themes, checked for
  sideways scroll on a phone, and checked that its proof of work actually runs under the
  strict CSP it is served with. A challenge that cannot start is a denial of service to
  the exact population the guard exists to protect. It was clean, and now it stays that
  way.

- **Acting on one client, not just reading about one — `controls.editRanges`.** Off by
  default. It puts three operations on the actor drill-down and on every row of the new
  Actors screen: allowlist the address, forget that actor's behavioural memory, or grant
  it human clearance for an hour. All three existed in the engine and were reachable
  from nothing.

  **Forget** is the reason the flag exists. A person whose actor key collected a
  `confirmed-bot` — a shared office address, a phone that reused an IP — carried
  `priorConfirmations` for the rest of the window, and the only cure was Reset: throwing
  away every actor's history to fix one person's. **Allowlist** is the consequential one
  and asks twice, with the second button naming the address it is about to exempt,
  because an allowlisted address is not judged leniently — it is not judged at all. The
  whole control is unavailable under `redact.maskIp`, where the key on screen names a
  `/24` and the registry is keyed by the address.

- **An Actors screen.** Everyone the *registry* is holding, busiest first — requests,
  requests per minute, distinct paths, cadence regularity, prior confirmations,
  clearance. The feed's ring holds a few hundred *requests*, which on a busy origin is a
  few seconds; the registry holds up to `maxActors` *clients* with the history that
  `cadence`, `crawl-breadth` and `rate-anomaly` are reading. "Who is hitting me hardest
  right now" had nowhere to be asked. **In feed** sends one to the live feed as an
  `actor:` filter, so it is a shareable URL like every other view.

- **A request tester.** Paste a User-Agent, a `curl` command out of devtools or a raw
  header block, and see the verdict, the evidence and the rule that would fire — without
  waiting for that client to come back, and without the investigation showing up in the
  thing being investigated.

- **`assess(facts, { record: false })` — a dry run.** Every detector runs and the verdict
  is real; no counter moves, no actor state changes, no `assessment` event fires, no
  notification is sent. What backs the tester, and what to reach for anywhere else you
  want the engine's opinion about a request that is not happening. It has no history by
  construction, so what it answers is "what would this look like as a first request".

- **Changes are attributed.** `auth: { authorize }` may return a **string** — the
  viewer's name — instead of `true`, and basic auth supplies one without being asked.
  Every mutating method now takes a `{ by }`, and the name travels into the handler's
  `warning`, into the change event, and onto the timeline marker. The library still has
  no user model: it carries the name it was given.

- **Runtime changes are marked on the traffic timeline**, with what changed and who did
  it. A preview says "44 of 151 requests would be treated differently"; the marker is
  what lets you check whether it held.

- **`maxEventsPerSecond` on `DashboardOptions`** (default 100, `0` to disable). Every
  assessment used to go to every open browser, so a thousand requests a second was a
  couple of megabytes a second per viewer with Pause as the only lever. The cap is on the
  *stream* — the ring keeps everything, so the preview, the export and anyone
  reconnecting are unaffected — and the feed says how many were not streamed, because a
  thinned feed must never look like a quiet one.

- **`instance` on `DashboardOptions`**, defaulting to the hostname and shown in the
  header. A dashboard reports on one process; behind a load balancer with eight pods you
  are looking at an eighth of your traffic. Naming the instance does not aggregate
  anything, it stops a partial picture from looking like a whole one.

- `range-change` and `actor-change` events, with `onRangeChange` and `onActorChange`.
- `BotHandler.forgetActor()`, `clearActor()`, `rangeEntries()`, `ActorRegistry.top()` and
  `IpRangeSet.entries()` — the engine surface behind all of the above. A range set could
  report how many entries it held and not which.
- `sections.registry`, `sections.tester` and `sections.ranges`.

- **`sections` on `DashboardOptions` — what a listener shows, as opposed to what it
  lets you do.** `feed`, `evidence`, `actors`, `statistics`, `audit`, `notices`,
  `policy`, `guard` and `robots`, all on by default. Switching one off removes it from
  the page *and* from the server: the tab is gone, the endpoint behind it answers 403,
  and the fields it would have shown are dropped before they leave the process — so a
  viewer with devtools open sees exactly what the page sees. `evidence` is the one to
  think about before sharing a dashboard widely: it names which detector fired and why,
  which is a tuning guide for whoever is scraping you.

  There is still no role model in here, and that is still deliberate. `controls` says
  what a viewer may do, `sections` says what a viewer may see, both are fixed when the
  listener starts, and roles are yours: one listener per role, your own `authorize`
  predicate in front of each. `npm run demo:roles` is now three of them.

- **`controls.editGuard` — the guard, changeable from the dashboard, behind its own
  flag.** Off by default. With it on, the Guard panel becomes a form over
  `falsePositivePolicy`, `fallbackAction`, `defaultAction`, `terminalScoreThreshold`
  and `suspectThreshold`, applied to the running handler through a new
  `POST /api/guard`.

  It is a *separate* flag from `editPolicy` because they are different powers. A rule
  editor can only write a rule that overreaches, and the guard stops it; this changes
  whether anything stops it. Two settings stay impossible whatever the flag says: a
  terminal `fallbackAction`, which would make every downgrade deny the request the
  downgrade existed to protect while still recording it as a guard stop, and a
  `terminalScoreThreshold` outside 1–100. Changes are validated before anything moves,
  applied whole or not at all, previewable against the traffic in the window, and
  announced through both `warning` and a new `guard-change` event carrying the before
  and the after.

- `BotHandler.updateGuard()`, `Policy.replaceGuard()`, `Policy.describeGuard()` and the
  `GuardSettings` type — the API behind the above, usable without a dashboard.
- `onGuardChange` on `BotHandlerOptions`, and `guard-change` on `BotHandlerEvents`.
- **A score histogram in the metrics.** `scores` on `MetricsSnapshot` and
  `bothandler_score_bucket` in the Prometheus output: how suspicion is distributed
  across everything that was scored, in ten buckets of ten points, since the process
  started. Proven assessments are excluded — their score is 100 by definition and
  decides nothing.
- **The dashboard's live feed can be searched by field.** `actor:203.0.113.4`,
  `-path:/health`, `rule:no-scrapers`, `score:>70`, `"a quoted phrase"`; every term
  must match. Anything that is not a field term still matches the whole request, so a
  plain word behaves as it always did.
- **"Draft a rule" on any feed row.** Turns the request you are looking at into a rule
  in the policy editor, matched on the strongest thing it actually proves — a verified
  identity, else the detectors whose evidence was proven, else the verdict with a score
  floor — appended last, previewed immediately, applied never. The action is always
  `tag`: a drafted rule has been reviewed by nobody, and a dashboard choosing a terminal
  action for a request that annoyed you is the reflex this library exists to interrupt.
- **Export the window.** The feed toolbar downloads every request matching the current
  filter as replay JSONL — the bulk form of the per-row buttons.
- **The filter and the search are in the URL**, alongside the view, so a screen is a
  link rather than a set of instructions and a refresh keeps your place.
- A time column on the feed, and a scope switch on the score distribution.

- `allowedHosts` on `DashboardOptions` — extra `Host` values a loopback
  dashboard will answer to, for reaching it through a name of your own. `"*"`
  disables the check.
- `clock` on `RedisStoreOptions`. The rate-limit window came from `Date.now()`
  while every other stateful piece of the library takes an injectable clock,
  which is why the window boundary could not be tested.
- `npm run demo:roles` — a second demo showing the dashboard behind roles: a signed
  session cookie, an operator console to pick a role at, a read-only viewer dashboard
  for analysts, and an admin dashboard with the editor and reset. It exists to make
  three things visible before someone builds them wrong: a custom `authorize` sends no
  `WWW-Authenticate`, cookies are scoped by host rather than by origin, and a session
  cookie is not what stops a forged write.

- `refusal` on `DashboardOptions` — what a caller the dashboard will not serve is
  told: `"unauthorized"` (401, the default), `"not-found"` (404, byte-identical to
  an unknown path), `"close"` (drop the connection), or `{ redirect, status? }`.
  Anything but the default also collapses the three pre-routing refusals — failed
  auth, wrong `Host`, cross-site write — into one answer, so a probe cannot tell
  which check turned it away. It is concealment rather than access control, and
  combining a silent refusal with basic auth is refused at startup: a browser
  prompts for a password only when a 401 asks it to.
- The dashboard page is navigable by keyboard. The tab strip now honours the
  keyboard contract its `role="tablist"` was already promising (arrow keys,
  Home/End, a roving tabindex), feed rows are focusable controls that open on Enter
  or Space rather than click alone, `/` jumps to the filter, `1`–`3` switch views,
  Escape backs out of whatever is open, and there is a skip link past the header.
- The current view is in the URL, so a screen can be linked to, the back button
  moves between views instead of leaving the page, and a refresh keeps your place.

### Changed (the dashboard)

- **The live feed updates in place instead of being redrawn.** It used to empty the
  table and rebuild up to three hundred rows on every frame that carried a request. The
  expensive part was not the visible problem: a rebuilt row takes your text selection
  with it, so copying a User-Agent out of a live feed was impossible without pressing
  Pause first. Rows are now keyed by request id and rebuilt only when the entry behind
  them changed.
- **Only the visible screen is drawn.** Every incoming request used to rebuild eight
  statistics panels into a hidden tab, at the frame rate, on top of the feed.
- **The Statistics screen says which window each panel is counting.** Half of it counts
  the retained ring and half counts since the process started — different populations
  wearing the same grey subtitle, on the screen people read before moving a threshold.
  Window-scoped panels now say how much window there is ("last 500 requests · 4 min"),
  and the score distribution defaults to the whole run, drawn from the same counters the
  Prometheus endpoint exposes, with the window one click away.
- **A reconnecting viewer is sent what it missed, not the whole ring.** Every frame
  carries an id and the server honours `Last-Event-ID`, so a laptop lid or a proxy
  timeout costs a handful of frames rather than five hundred entries with their headers,
  evidence and actor history attached. A cursor the server cannot honour gets the
  backlog and an instruction to replace what the page holds.
- **One stats timer for every viewer** rather than one per viewer: sixteen browsers on
  the same dashboard meant sixteen identical snapshot walks every two seconds.
- **Reset tells every viewer**, not just the browser that pressed it.
- **The dashboard's browser code is a real TypeScript module** under
  `src/dashboard/client/`, type-checked, linted, unit-tested and bundled into the page
  at build time by `npm run client:build`. It used to be two thousand lines of
  JavaScript inside a template literal, which is how a call to a function nobody had
  written shipped and blanked the whole Statistics tab: the type-checker could not see
  it, Biome globs `*.ts` and this was a string, and no test could import a function out
  of it. The pure parts — the search, the outcome classification, the rule drafting, the
  replay formats — now have unit tests that run without a browser.
- **The header no longer dresses status as controls.** Five bordered pills carrying
  configuration facts sat beside five identical-looking pills that were real buttons,
  which is not a toolbar but a guessing game. The facts moved to the tab strip's
  empty right-hand side as plain text, label first and value second — "suspect at
  60", not "60 suspect at" — the links and actions are grouped and divided, and
  Reset, which discards the actor registry, is finally styled as the destructive
  action it is.

### Fixed (dashboard page)

- **The Statistics tab threw on every render.** `draw()` called `drawAudit()`, which
  was never written — so the Audit panel had never once rendered, and the
  `ReferenceError` aborted `drawStats()` on the very next line, leaving the panels
  below it empty too. Implemented: the audit's window and its baseline side by side,
  because a bot share of 60% is a number and 60% against a baseline of 12% is an
  incident. Found by the browser suite on its first run.

- **The sticky column headers never stuck.** Two faults on top of each other. They
  were pinned to a hard-coded `54px` — the top row alone, with the tab strip
  unaccounted for — and the panel around them was `overflow: hidden`, which makes it
  a scroll container and therefore the containing block for anything sticky inside
  it. The offset is measured at runtime now, and the panel clips instead of hiding.

- **The header overlapped itself on a narrow window.** Its top row was a fixed 54px
  with children that refused to shrink, so below about 900px the title and the live
  indicator drew on top of one another. It wraps now, and nothing in the header has a
  fixed height.

- **The feed table was amputated below about 900px** — the panel simply clipped the
  right-hand columns. The duration column now goes first, and below that the table
  scrolls inside its own box rather than losing data. The scroll container is scoped
  to those widths on purpose: it would otherwise become the containing block for the
  sticky column headers and cost them on every screen.

- **The skip link was not reachable by Tab.** Parked at `top: -60px`, its whole
  border box sat outside the viewport, and sequential focus navigation drops those —
  so the one control that exists purely for keyboard users was the one control a
  keyboard could not get to. Clipped rather than moved now.

- **A slow viewer could grow this process without limit.** `response.write()` returns
  false when the socket's buffer is full and nothing looked at it, so the frames for a
  viewer that had stopped reading — a laptop that slept with its tab open, a phone in a
  tunnel, a proxy that stopped draining — accumulated in memory, one queue per viewer.
  `maxEventsPerSecond` does not help: it bounds a rate and this is a backlog. A stream
  that reports itself full is now sent no feed entries until it drains, is told how many
  it missed when it catches up, and is ended after twenty seconds of never draining —
  after which the browser reconnects and resumes from its cursor.

- **Accessibility defects nobody had noticed by looking**, found by the new axe pass and
  then by widening it. Solid buttons put white text on the series blue at about 3.9:1,
  under the 4.5 floor — they have a darker accent of their own now, and the charts keep
  the validated series colour. Feed rows were `role="button"` with the actor link inside
  them, which is a control nested in a control; each row's method-and-path is a real
  disclosure button now, and clicking anywhere in the row still opens it.

  The first version of that pass ran in light mode at one width and passed, while the
  dark palette had a serious contrast failure on every piece of weak evidence. Widened
  to both themes and both widths, it also found that the page had **no `h1` at all** —
  "jump to the heading" had nothing to jump to — and an unlabelled column header. Four
  more inks failed once measured in the contexts they actually appear in: a suspected
  badge is an amber ink on a 16%-amber chip on a row that may itself be tinted, which is
  three surfaces deep and passes at every stage but the last. The amber and the muted
  inks are darker now, and a test measures **every** badge, action, tier and caption
  against **every** surface it can land on, in both themes — because axe can only audit
  the badges the traffic happened to produce that afternoon.

- **A half-pressed confirmation could be reset under the operator's cursor.** The Actors
  screen refreshes every couple of seconds and a refresh rebuilds its buttons, so
  somebody who clicked "Allowlist", read the address it offered back and reached for the
  second click could find the second click had merely armed it again. Which teaches
  people that the way through a confirmation is to click it twice, quickly — the exact
  habit a confirmation exists to prevent. The list holds still while somebody is
  deciding.

- **The guard form's labels were not attached to anything.** Four controls with visible
  captions and no association, which reads as "edit, blank" to a screen reader. Both
  form builders use one helper now that either points the label at its control or gives
  the group an accessible name.

- **Warnings raised outside the engine never reached `warning` subscribers.** The fetch
  adapter's "I cannot determine a client address" — the one that means every visitor
  collapses into a single actor — called `config.onWarning` directly, which reaches the
  callback and not the event. So it never appeared in the dashboard's notices, where an
  operator would actually see it. Both paths go through `warn()` now.

- **A CLI flag's value could be read as the request.** `bothandlerjs explain --json
  curl/8.4.0` treated the User-Agent as the value of `--json`, found no positional
  argument, and sat waiting on a pipe nobody was writing to — a command that looks hung,
  and in a script is. Flags that take a value are named explicitly now, and only an
  *absent* argument reads stdin.

- **Every warning reached `onWarning` twice.** `warn()` emits the `warning` event *and*
  calls `config.onWarning`, and `onWarning` was also registered as a listener for that
  event — so the one channel most likely to be wired to a pager was the one that
  double-fired. Found while adding attribution to the runtime-change warnings.

- **A User-Agent beginning with `curl` was read as a curl command.** In the new request
  tester, `curl/8.4.0` — the single most likely thing anybody pastes, since it is what
  the feed shows next to the request they came to ask about — parsed as a command with
  no arguments, producing a request with no User-Agent and a verdict of "unknown". Which
  is the most misleading answer available, because it looks like an answer.

- **The feed table was still being clipped, on most desktops.** The breakpoints that
  drop a column when it will not fit were media queries, and the box the table has to
  fit inside is the panel — one column of a two-column grid, about 880px wide at a
  1400px viewport. So the 980px breakpoint never fired where it was needed and the
  right-hand columns were simply not drawn. They are container queries now, measuring
  the panel, and a test walks ten widths asserting the table either fits or scrolls and
  is never clipped.

- **A title or link label containing `$&` would have rewritten the page around it.**
  The page template used string replacements, and `String.prototype.replace` reads
  `$&`, `` $` `` and `$'` out of a string replacement and substitutes match context for
  them. Function replacements throughout now.

### Changed

- Test coverage of the adapters went from 47% to 94%. They are the only code
  here that every user runs, and the Fastify adapter had never executed in a
  test at all.
- Linting with Biome (`npm run lint`), matching the configuration used across
  the sibling projects, and a coverage ratchet (`npm run test:coverage`).
- CI now lints, runs on Node 24 as well as 20 and 22, and checks the shape of
  the published package: zero runtime dependencies, no non-`node:` runtime
  imports, no advisories reaching a consumer, and a bounded tarball.

## [0.1.0]

- Initial release.
