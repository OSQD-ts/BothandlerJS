# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Shadow mode: run a detector and let it decide nothing.** `shadowDetectors: ["path-novelty"]`
  runs the named detectors on every request exactly as they otherwise would and keeps their
  findings out of the verdict, the score, the class, the identity and every rule. They land
  in `assessment.shadowEvidence`, counted and charted next to the evidence that did decide.
  This is deliberately not a weight of zero: a weight is consulted only on the probabilistic
  path, and `certain` evidence never reaches that path, so a shadowed detector emitting it
  would have blocked people with its weight sitting at zero the whole time.

  `assessment.shadowVerdict` carries what the verdict *would* have been, computed only when
  a shadowed detector actually found something. "It fired 312 times" is not a number anybody
  can act on; "it would have moved 41 requests to `suspected-bot`" is. Prometheus gains
  `bothandler_shadow_firings_total` and `bothandler_shadow_verdict_changes_total`, both
  absent entirely while nothing is shadowed.

  The correlation sources are why this exists: several of their detectors fire at `moderate`
  on real people by design — a phone roaming between networks, a crowd on a broken link,
  somebody tapping "Request desktop site" — and whether the thresholds are right *for your
  site* is not a thing this library can know. See `docs/detection/shadow-mode.md`.

- **`target-integrity`, and the raw request target it reads.** `facts.path` is normalised so
  that a rule scoped to `/admin` holds against `/%61dmin` and `/./admin`. That normalisation
  is also what makes an evasive target look ordinary: `/%2e%2e%2f%2e%2e%2fapp/config.yml`
  arrives as `/app/config.yml`, which is on no wordlist and reads like a broken link.
  `facts.rawPath` now keeps the target as it was spelled — and only when it differs from the
  normalised form, so ordinary traffic pays nothing for it.

  The detector reports encoded traversals, double encoding, encoded control characters,
  absolute-form targets addressed to a proxy, and separators hidden inside a segment. None
  of it is `certain` and the closest call says why: a path segment carrying a URL as *data*
  is encoded once to sit in a path and again by whatever built the link around it, which
  produces `%252e` honestly on a site that has done nothing wrong.

- **The feed filter takes `$and`, `$or`, `$not`, `$in` and `$notin`.** Adjacent terms
  still mean `AND` and `-term` still negates, so every existing query and saved filter
  reads the same — but the parser produces a tree now rather than a flat list, which is
  what `$or` needs and what the previous version communicated by silently ignoring the
  word. `$not` binds tightest, then `$and`, then `$or`, and brackets group. Operators
  carry a `$` because a bare `or` appears in User-Agents and paths, and a language where
  an ordinary search word becomes an operator lies about what it matched. Nothing throws:
  an unclosed bracket, a dangling `$or` and a half-typed `$in(` are all the normal state
  of a live search box.

- **The Actors screen lists either the registry or the actors in the feed.** A toggle
  above the table. The registry answers "who is hitting me hardest"; once a filter is on,
  the question is usually the other one — "who is in *this*" — and the screen could not
  answer it. The feed-derived list leaves `Per min`, `Cadence` and `Unsolved` blank rather
  than computing them from a few hundred requests, because those are properties of a
  client's whole history and a confident number under the wrong heading is worse than a
  dash.

### Changed

- **The browser suite runs on Chromium, Firefox and WebKit.** `BROWSER_ENGINE` picks one
  locally (`npm run test:browser:firefox`, `:webkit`); CI runs all three as a matrix.
  Testing a single engine is how the Safari header bug shipped, and Firefox earned its
  place on the first run by catching the challenge page's CSP error.

- **The feed's column headers stick in Safari.** The tables collapsed their borders, which
  is a long-standing sore point for sticky table cells in WebKit — the CSSWG has an open
  issue on collapsed borders not following a cell when it sticks, and Safari is widely
  reported to drop the stickiness of a `th` outright. The header held in Chromium and
  Firefox and was reported adrift in Safari, which is what a sticky element that has
  stopped sticking looks like. They separate their
  borders with zero spacing now, which no border in these tables relied on: the only
  measurable difference is the accent column starting two pixels earlier, because
  collapsing left half of that 3px border outside the cell. A browser test scrolls the
  page and asserts the header holds, since one keyword can undo this silently.

- **The feed's Exclude button is gone; `$not` replaces it.** It kept a hidden list in one
  person's browser, which meant a view with the noise taken out could not be shared. A
  `$not` lives in the URL like every other narrowing.

- **Labelling an actor edits in place instead of calling `prompt()`.** A sandboxed iframe
  blocks `prompt()` outright, so on an embedded dashboard the Label button did nothing at
  all, with no error and no way to tell.

- **Correlating a client's own requests, through a marker cookie.** `probe` is a new,
  opt-in source: the engine issues a signed first-party cookie and reads it back, so two
  requests can be attributed to one *client* rather than to one address. That closes a gap
  the library had documented and declined to guess at — `identity-rotation` reads "one
  actor, several User-Agents" as lying, and under an address-derived actor key that
  describes every office and carrier on the internet, so it has always shipped switched
  off. A marker carries an HMAC only this server can produce, which makes the same
  observation evidence instead of speculation.

  Four detectors arrive with it. `identity-drift` compares the identity claimed now with
  the one claimed when the marker was issued, weighing a changed *browser family* at
  `strong` and a changed platform at `moderate` — because "Request desktop site" on a
  phone does the latter and the person doing it is a person. `marker-integrity` reports a
  marker signed with a key we do not have. `marker-fanout` counts the networks one marker
  has been presented from. `marker-persistence` reports a client that sends cookies but
  never ours, deliberately narrower than `session-integrity`, which already covers a
  client that sends none.

  It is off by default and sets a cookie only when the client holds no valid one, so an
  ordinary visitor is issued one on the first request of a session and no other. `secrets`
  is required and has no default: a secret generated at startup would read every marker
  minted by another replica as forged.

- **Reading what a client does when it is challenged.** `challenge-reaction` reports an
  identity that changes within seconds of a challenge, and a client challenged repeatedly
  that has never answered. It is the only detector here whose stimulus this library chose,
  which is what lets it reach `strong` — and it reports the same observation a tier lower
  when only an address ties the two requests together, because that is how much less an
  address-based join is worth. `challenge-integrity` reports solutions that were replayed,
  or returned faster than the proof of work can be computed in a browser.

- **Comparing a client with the rest of your traffic.** `site` is a second opt-in source
  holding a bounded, warmed-up baseline of what a site normally serves. `distributed-walk`
  finds a numeric range walked across many clients where none walks enough of it alone —
  the one threat per-actor thresholds miss by construction. `path-novelty` is a
  self-maintaining wordlist. `path-campaign` reports a path the site never served that
  many unrelated clients suddenly want, requiring the miss rate so that a successful
  launch is not reported as an attack. `miss-baseline` is `probe-volume` measured against
  the site's own rate rather than a fixed threshold.

  Nothing is reported until `warmupRequests` have been observed, because every path is
  rare when nothing has been seen. Walk ids are held as a coarsening bitmap and marker
  fan-out as a 128-bit sketch, so neither table grows with what a client chooses to
  request.

- **`indexers-only`, a preset for sites that want search traffic and nothing else.**
  Serves a bot only when its identity has been confirmed by DNS or a published range
  *and* it is a `search` or `social` crawler; refuses every other proven bot; challenges
  suspicion and holds weak signal to a ceiling. It is the first shipped preset whose
  terminal rules cover all proven automation permanently rather than during an incident.

  Read its documentation before choosing it. Twenty-three of the shipped search and
  social signatures — Twitterbot, LinkedInBot, Slackbot, Discord, Telegram, WhatsApp,
  Reddit, Mastodon, Bluesky among them — publish nothing that can confirm a claim, so
  they can never be verified and `unverifiable-indexer-block` refuses them, taking your
  link previews with it. Fifteen of the corpus's infrastructure cases are refused too,
  including health checks, a server-side renderer and a payment webhook: allowlist your
  own automation above the preset before switching it on.

- **`<bot-dashboard>`, the dashboard as an element.** A new entry point,
  `@osqd/bothandlerjs/element`, exporting `defineBotDashboard()`. Mount
  `createDashboardHandler` as before and drop the element into a page you already
  have: it renders the whole dashboard into a shadow root in your own layout, under
  your own heading, rather than on a route of its own.

  `config.tabs` chooses which of the four screens appear, in what order and under what
  labels. `config.theme` sets the scheme, the density and any of the stylesheet's
  tokens — which is why every token block is now written `:root, :host`, since `:root`
  matches nothing inside a shadow tree. `config.panels` adds panels of your own, fed
  by a URL or a function and rendered as text.

  **Be clear about what embedding costs.** A shadow root is a styling boundary and not
  a security boundary: any script that can run on the host page can read every client
  address and every piece of evidence the dashboard renders, and call its API with your
  credentials. On the standalone page it could not. Mount it behind your admin
  authentication and treat an XSS on that page as equivalent to handing the dashboard
  over — or serve the standalone page, which is the same dashboard and already
  isolated. `config.hide` is cosmetic; `sections` on the handler is the setting that
  stops data leaving the process.

  Embedded, the dashboard stops doing four things it does when it owns a page: binding
  its keyboard shortcuts to the window, where a digit pressed on the host page switched
  a tab in here; writing its tab and filter into `location.hash`, which is the host's
  address bar and its back button; relying on a fragment anchor for the skip link,
  which is inert across a shadow boundary; and refusing to mount a second time, which
  made it unusable under any router, since unmount-and-remount is what a route change
  is. A remount now keeps the feed history it had built.

  `GET {basePath}/api/bootstrap` is new, serving the element the same configuration the
  standalone page carries stamped into it.

  The entry point imports safely on a server — Next, Remix, Astro and the rest evaluate
  top-level imports while rendering, where there is no DOM — and `defineBotDashboard()`
  does nothing until it is in a browser, so it can be imported like anything else and
  called on mount.

- **An interaction challenge.** `challenge.interaction` asks the interstitial for a
  deliberate gesture as well as the proof of work, and probes what the browser can
  actually do while it waits. Six probes read back things only a rendering engine
  produces — a computed style that requires the cascade to have run, a laid-out box,
  font metrics that differ between two families, a frame loop, a media query, an element
  that `display: none` actually hid. One of them is different for every challenge: the
  box count and box height of the layout probe are drawn from the nonce under the
  signing secret, so the client cannot compute the answer and can only measure it.

  When it is on, solving the puzzle alone no longer grants clearance: the gesture is
  required, and passing grants the `interaction` clearance level, which the `clearance`
  detector has always known how to read and which nothing until now ever granted.
  `challengeTtlMs` defaults to ten minutes rather than two, because the page now stops
  and waits for a person to read it.

  The gesture is a checkbox, and that is the whole accessibility argument: it is the one
  interactive control that a pointer, a touch screen, the space bar, a screen reader,
  switch access and voice control can all operate. A tap and a keypress are reported as
  what they are and never marked down for producing no pointer path, and a pointer path
  too short to measure is treated as no evidence rather than bad evidence.

  **Be clear about the ceiling, which is measured rather than assumed.** A client that
  replays a report captured from a real browser gets nowhere, and one that hardcodes a
  formula for the layout probe gets nowhere — but one that *parses the served HTML and
  CSS each time* passes every check, because both numbers have to reach the browser to
  be rendered. Against an adversary who writes a parser for your challenge page this
  adds nothing over the plain proof of work beyond the server-verified elapsed-time
  floor, and no client-side probe can. What it defeats is every scraper that does not
  bother. Nothing here is proof of humanity and none of it is ever `certain`.

- **Counters for the challenge that were not there.** `bothandler_clearances_total` by
  level, `bothandler_challenge_rejections_total` by cause, and
  `bothandler_interaction_score_bucket` in tenths, fed by refusals as well as successes
  so the distribution is not censored at the threshold it exists to inform. The
  `challenge` event carries `level`, `score` and `reason` to match.

  `MetricsSnapshot` gains three fields, so anything constructing one by hand needs them.

- **A test that parses the interstitial's own inline script.** The page is built inside
  a template literal, where one backtick — in a comment, a string, a regular
  expression — ends the literal early and turns the rest into markup.
  `tests/challenge-page.test.ts` parses the rendered script with `node:vm`, including
  with operator-supplied copy that contains a backtick.


### Fixed

- **An embedded dashboard could point at the host application instead of at `src`.**
  `disconnectedCallback` imports the stream module to close the stream, that module
  imports the boot module, and the boot module read its mount path off the global once,
  when it was first evaluated. A host page that mounted, unmounted and remounted the
  element before the first bootstrap fetch returned — React 18's development double-mount
  — ran that import while the global was still undefined, so the base froze at `""` for
  the life of the page.

  Nothing threw. Every request the dashboard made afterwards went to the host page's own
  origin root rather than to `src`, so it drew no traffic while sending `/api/stream` and
  `/api/stats` to somebody else's router, and the only outward sign was an `EventSource`
  complaining about a MIME type on whichever engine reports that. The element now hands
  the payload over explicitly, so being evaluated early costs nothing.

- **Pressing "Load them" left the "not streamed" badge on screen.** The count of how much
  of the gap had been closed was taken from the page's own snapshot, which is refreshed on
  a timer and so was usually several seconds out of date; a snapshot arriving afterwards
  with a larger count reopened a gap that had just been closed. `/api/feed` now returns
  `skipped` alongside the backlog, so the number comes from the response that closed the
  gap rather than from one taken before it.

- **`RedisStore.increment` could leave a counter key that never expired.** `INCR` then
  `PEXPIRE` is two commands, and a process killed between them orphaned a key nothing would
  ever revisit — the next request falls into the next bucket, under another key. The expiry
  is now armed by the command that *creates* the key: `SET … PX … NX` issued without waiting
  for its reply, then `INCR`, so both are on the wire together and this stays one round trip.
  Not a Lua script, because `eval` is the one command `ioredis` and `node-redis` spell
  differently enough that `RedisLike` could not describe both. `pexpire` has left that
  interface, which needs four commands now rather than five.

- **The interaction challenge marked down somebody who paused mid-movement, twice over.**
  Samples arriving more than a quarter of a second apart are dropped before anything is
  measured, because the distance across a pause is not a distance a hand travelled — but
  `fractionalShare` was dividing the samples it kept by the count of everything that
  arrived, reporting *fewer* sub-pixel coordinates than the samples it was computed from
  actually had. That reads as "these coordinates are integers", which is the signature of an
  interpolated path. Separately, whether a path was measurable at all was decided from the
  raw array length while the scoring judged the kept samples: four pointer samples with a
  pause before each one were four to the array and none to the analysis, so the report was
  called measurable and then scored at zero. Both cost the reading pattern most likely to
  produce them — move the pointer, stop to read, move again.

- **Save and Cancel on the actor label editor, which three earlier attempts could not fit.**
  `input[type="text"] { width: 100% }` outranks a bare class selector, so the editor's
  `width: 15ch` had never applied: the box filled its shrink-to-fit container and pushed the
  buttons past the right edge of the panel, where they could be seen and not clicked.
  Qualifying the selector fixed the cause; the row's other actions now stand aside while the
  editor is open, which is also the right thing on its own — Allowlist and Forget are not
  what somebody naming a client is reaching for.

- **The Actors scope was not in the URL.** `#actors?a=feed`, pushed rather than replaced,
  because switching between the registry and the feed is a discrete act like clicking a tab
  and the back button should undo it. The feed-scoped list also shows a dash for
  `Confirmations` like the three columns beside it, rather than a confident zero under a
  heading that means "how many times has this client been proven a bot".

- **`bothandlerjs detectors --preset <typo>` answered anyway.** An unknown preset fell
  through to a handler with no preset and printed the default list at exit code 0 — a
  confident wrong answer to the one question the command exists for, while `robots` in the
  same file refused the same typo. It is refused now, with the same message. The command
  also notes that a preset selects rules rather than detectors, and that `challenge`,
  `probe` and `site` are what change the list; the note goes to stderr, so redirecting the
  list stays clean.

- **The default notification sink discarded the content of every error.** `consoleNotifier`
  never referenced `event.error`. An error carrying no assessment fell into the branch
  written for anomalies and printed `[bothandler] error unknown — ` at *warning* level, with
  the failing source and the message both dropped; one that did carry an assessment printed
  the request's evidence instead. Errors are how a failed detector, sink or store is
  reported, and this is the sink an operator gets without configuring one — so the default
  way to find out that a detector had been throwing showed neither which one nor why.

- **Every person shown a challenge page in Firefox got a security error in their
  console.** The page declares no icon, so the browser asks for `/favicon.ico` by itself;
  under `default-src 'none'` that request is refused, and Firefox reports the refusal as a
  CSP violation on a page whose entire purpose is to reassure somebody that nothing is
  wrong. The page now declares an empty icon so the request is never made, and the policy
  allows `img-src data:` — which permits nothing off the machine, a `data:` URI being
  inline by definition — so that declaration is honoured. Found by running the browser
  suite on Firefox for the first time.

- **Cookies split across several header fields were misparsed, losing every cookie after
  the first.** HTTP/2 permits a client to send its cookies as separate header fields and
  Node's `http2` surfaces them as an array; RFC 9113 §8.2.3 says a receiver concatenates
  them with `"; "`. They were joined with `", "` like every other header, which parses as
  one cookie whose value is the rest of the line — so a clearance token in the second
  field was invisible, and an HTTP/2 visitor who had solved a challenge was challenged
  again on every request.

- **`X-Forwarded-For` entries carrying a port were dropped.** Azure's Application Gateway
  and Front Door write `1.2.3.4:5678`, and RFC 7239 spells IPv6 as `[2001:db8::1]:5678`.
  Neither parsed, and because every entry in such a chain carries a port the whole chain
  emptied and every client behind that proxy resolved to the proxy's own address — sharing
  one actor, one history and one rate-limit bucket, so a single bot could lock out every
  real visitor.

- **Evidence summaries quoted client-controlled text without neutralising it.** A request
  path containing CRLF came back inside an `id-enumeration` summary exactly as sent, which
  forges log lines; escape sequences repainted terminals. Summaries and operator labels are
  now cleaned centrally, so detectors written elsewhere are covered too.

- **`probe-volume` was inert on three of the four adapters.** Only the Node adapter
  reported the status the application answered, so on Fastify, Koa and every Fetch runtime
  the detector was installed, listed, and structurally unable to fire.

- **The "N not streamed" badge outlived the feed it described.** The badge adds two
  counts: the server's rate-cap `skipped`, which `FeedRing.clear()` resets, and the
  connection's lagged drops, which nothing did. After a Reset — or after the replace-sync
  that follows a dropped stream, which is the likelier path, since a viewer dropped for
  lagging reconnects with a stale cursor and is sent a fresh backlog — the number went on
  reporting a gap in a window that had just been replaced, under a tooltip promising those
  entries were still in it.

## [0.3.0] — 2026-09-06

### Changed

- **The package is now `@osqd/bothandlerjs`.** Every import moves with it —
  `@osqd/bothandlerjs`, `/adapters`, `/client`, `/corpus`, `/cli` — and
  `npm install bothandlerjs` becomes `npm install @osqd/bothandlerjs`. The CLI command
  is unchanged: a `bin` name is independent of the package name, so `bothandlerjs check`
  still works once installed, and `npx @osqd/bothandlerjs` installs it.

  npm refuses capital letters in a new package name, so the spelling is
  `@osqd/bothandlerjs` rather than `@osqd/BotHandlerJS`. `publishConfig.access` is set
  to public, without which a scoped package publishes private on the first attempt, and
  the tarball is now `osqd-bothandlerjs-<version>.tgz`.

### Added

- **Releases are cut from `main`.** `scripts/next-version.mjs` reads the commits since
  the last release tag and works out the version — `feat:` minor, `fix:`/`perf:` patch,
  a `!` or a `BREAKING CHANGE:` footer major (or minor while the major is 0), and
  everything else nothing at all. That last rule is what makes publishing on every push
  tolerable: a documentation fix releases nothing.
  `.github/workflows/publish.yml` runs the full gate against the commit, refuses a
  version already on the registry, bumps and tags, inspects the tarball, and publishes
  with provenance.

- **A sixteen-lesson course**, in `docs/course/`, that builds one integration from a
  first assessment to a policy you can defend. Every checkpoint in it is real output
  from running the code.
- **A test for the published entry points.** `tests/entry-points.test.ts` asserts the
  surface of all four, which is the actual fix for the two entries below: every module
  in the repository imports its neighbours by path, so nothing exercised the paths the
  documentation tells other people to use.

### Fixed

- **`@osqd/bothandlerjs/corpus` did not export `runCorpus`.** That is the entire point
  of publishing the entry point, and the README, the changelog, the design notes and
  three documentation pages all told people to import it. It would have failed for
  everyone outside this repository, and no test could have noticed because every
  internal caller reaches past the entry point to `./runner.js`.

- **`renderClientScript` and `parseClientSignals` were documented on the root export.**
  They live behind `/client`, and the example omitted the required `endpoint` argument.

- **A challenge test failed about one run in 271, claiming a bad proof of work had been
  accepted.** It submitted the fixed solution `"1"` against a random nonce at difficulty
  8, where one guess in 256 is a valid proof by accident. It searches for a counter that
  provably misses now, and asserts that it misses before submitting it.

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

- **`bothandlerjs check` — your policy against 545 shapes of real traffic.** The question
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
