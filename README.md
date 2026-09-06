# 🤖 bothandlerjs

**Bot traffic detection and handling for TypeScript.** Identify automated traffic,
prove it where proof is possible, and respond the way you choose — tag it, slow it,
rate-limit it, challenge it, alert on it, or refuse it.

The design rests on one distinction that most bot tooling blurs: **proof versus
suspicion**. Evidence is tiered, the two tiers combine by different rules, and a guard
in the policy layer stops a probabilistic verdict from ever reaching a terminal
action. That is what this library means by *no false positives*, stated precisely:

> **Nothing is ever denied service on the strength of a guess.**

Guesses still do useful work — they tag, delay, rate-limit, challenge and alert. They
just cannot shut the door. Only deterministic evidence can, and every piece of
deterministic evidence has to explain in writing why it admits no benign explanation.

```bash
npm install @osqd/bothandlerjs
```

No runtime dependencies. The library imports nothing but `node:` builtins, and CI
fails if that ever stops being true — so nothing here can hand your project a
transitive advisory, an install script, or a version conflict with something you
already run. Redis, if you use it, is your client passed in: `RedisStore` describes
the five commands it needs structurally and imports neither `ioredis` nor
`node-redis`.

---

## Documentation

The README is the argument and the shortest path to a working integration. Everything
else lives in **[`docs/`](docs/index.md)** — thirty pages, one per question, each
explaining why a thing exists as well as how to use it.

| | |
| --- | --- |
| **[The course](docs/course/index.md)** | Sixteen lessons that build one integration, from a first assessment to a policy you can defend. Start here if the library is new to you. |
| **[Start here](docs/index.md)** | [Installation](docs/start/installation.md) · [Your first integration](docs/start/first-integration.md) · [Choosing a policy](docs/start/choosing-a-policy.md) · [Upgrading](docs/start/upgrading.md) |
| **Concepts** | [Evidence and certainty](docs/concepts/evidence.md) · [Verdicts and scores](docs/concepts/verdicts.md) · [The safety guard](docs/concepts/the-guard.md) · [Actors](docs/concepts/actors.md) · [Threat model](docs/concepts/threat-model.md) |
| **[Detection](docs/detection/index.md)** | [The 20 detectors](docs/detection/detectors.md) · [Signatures](docs/detection/signatures.md) · [Verification](docs/detection/verification.md) · [Browser signals](docs/detection/client-signals.md) · [Writing a detector](docs/detection/writing-a-detector.md) |
| **[Policy](docs/policy/index.md)** | [Rules](docs/policy/rules.md) · [Actions](docs/policy/actions.md) · [Presets](docs/policy/presets.md) · [robots.txt](docs/policy/robots.md) · [The challenge](docs/challenge/index.md) |
| **[Operations](docs/operations/index.md)** | [The dashboard](docs/operations/dashboard.md) · [Embedding it](docs/operations/embedding.md) · [Metrics](docs/operations/metrics.md) · [The audit](docs/operations/audit.md) · [Notifications](docs/operations/notifications.md) · [Runtime changes](docs/operations/runtime-changes.md) |
| **[Integration](docs/integration/index.md)** | [Adapters](docs/integration/adapters.md) · [The client IP](docs/integration/client-ip.md) · [Stores](docs/integration/stores.md) |
| **[Testing](docs/testing/index.md)** | [The CLI](docs/testing/cli.md) · [The corpus](docs/testing/corpus.md) · [Log replay](docs/testing/replay.md) · [Try it locally](docs/testing/try-it.md) |
| **Reference** | [Configuration](docs/reference/configuration.md) · [API](docs/reference/api.md) · [Design decisions](docs/design/decisions.md) |

---

## Why this design

Every bot detector eventually faces the same problem. The signals that catch
sophisticated automation — header consistency, TLS fingerprints, timing regularity,
missing cookies — are all *probabilistic*. Each one has a population of real people
who trip it: someone on a privacy-hardened browser, behind a corporate proxy, using a
screen reader, on a hotel network, on a five-year-old phone.

The usual answer is to add the signals into a score and block above a threshold. That
is exactly the mistake. Points do not compose into proof. Two unrelated suspicions
about an unusual but entirely real browser reach 100 just as readily as two
well-founded ones, and the people who get caught are disproportionately the ones with
the strongest reasons for their unusual setup.

So this library keeps the two kinds of evidence in separate compartments, all the way
through:

|                      | Deterministic (`certain`)                                        | Probabilistic (`strong` / `moderate` / `weak`) |
| -------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| What it rests on     | A declaration, a contradiction, a trap, or an external authority | A pattern that automation usually shows         |
| Can it be wrong?     | Only if the client lied about itself                             | Yes, about real people                          |
| How it combines      | Short-circuits to a verdict                                      | Noisy-OR into a 0–99 score                      |
| Can it block?        | **Yes**                                                          | **No** (under the default policy)               |
| What it can still do | anything                                                         | tag, log, delay, rate-limit, challenge, alert   |

The guard that enforces the last row lives in the policy layer and runs *after* a rule
has been chosen — so it cannot be forgotten in a rule, worked around by a clever
predicate, or bypassed by someone who has not read this document. Relaxing it is one
explicit, greppable setting.

---

## Quick start

```ts
import { BotHandler } from "@osqd/bothandlerjs";
import { botHandler } from "@osqd/bothandlerjs/adapters";

const detector = new BotHandler({
  preset: "protect-content",
  challenge: { secrets: [process.env.BOT_SECRET!] },
  allowlist: ["10.0.0.0/8"],            // your monitors and CI
  ignorePaths: ["/healthz", "/metrics"],
});

app.use(botHandler(detector));

// Optional: a live view of what it is doing, on a port of its own.
await detector.serveDashboard({ port: 9674 });
```

That is a working configuration. Against a live server it produces:

| Request                                     | Result                                        |
| ------------------------------------------- | --------------------------------------------- |
| A real Chrome navigation                    | `200` — served, untouched                     |
| `curl https://yoursite/`                    | `429` — challenge page (proven `http-client`) |
| A `Googlebot` UA from an address DNS refutes | `403` — proven `impersonator`                 |
| `sqlmap`                                    | `403` — self-identified scanner               |
| A hit on a trap link                        | `403` — no person can reach it                |
| `GET /healthz`                              | `200` — never assessed                        |
| Real Googlebot, confirmed by DNS            | `200` — explicitly allowed                    |

---

## The certainty model

### What earns `certain`

Only five things, and each is deterministic for a stated reason:

1. **Self-declaration.** The client says it is a bot: `curl/8.4.0`,
   `python-requests/2.31.0`, `Googlebot/2.1`, `HeadlessChrome` in a Client Hints brand
   list. We are not inferring — we are believing the client's own statement about
   itself, and no honest client is ever harmed by being believed. If the statement is
   a lie, the misclassification is the client's doing.
2. **A refuted third-party identity.** A client claimed to be Googlebot and
   forward-confirmed reverse DNS says otherwise. Note how narrow this is: a privacy
   extension rewriting a UA to a generic browser string never lands here, because it
   never claims to be a *named, verifiable* third party.
3. **A confirmed third-party identity.** The same check passing. Used to *allow*.
4. **A trap.** A link hidden from layout and from assistive technology, excluded in
   `robots.txt`. Detection by construction rather than by inference — there is no
   sequence of user input that reaches it.
5. **A protocol violation.** Three of them, each a rule the specification requires a
   recipient to *enforce* rather than merely recommends: a connection-specific header
   on HTTP/2 (RFC 9113 §8.2.2), a message carrying both `Content-Length` and
   `Transfer-Encoding` (RFC 9112 §6.1), and a repeated `Host` or `Content-Length`
   (RFC 9112 §3.2). A client emitting any of them cannot talk to a compliant proxy, so
   no shipping client emits one — and the last two are the ambiguity every
   request-smuggling technique is built on.

Plus one on the human side: **your application's own assertion** (`isHuman`, or an
`operator` clearance token) that a request belongs to a person.

One rule holds all of this together, and it is worth stating on its own:

> **No argument from absence may ever be `certain`.**

A header missing from the facts is not a header missing from the request. An HTTP/1.1
request with no `Host` violates RFC 9112 as plainly as anything above — and it is
deliberately *not* proven here, because a caller building facts from a log line, a WAF
event or a partial adapter would otherwise manufacture proof against every request in
the file. The protocol checks that did make the list all reason from what is
**present**.

### What does not

Everything else, including several signals that look conclusive:

- **A User-Agent that contradicts itself.** Chrome on an iPhone, where Apple's rules
  mean Chrome is WebKit and says `CriOS`; Windows and macOS in one string; Firefox
  claiming the WebKit engine. These describe a client that has never shipped — and
  they are also what a person's UA-spoofing extension produces. `strong`.
- **UA / Client-Hints contradictions.** A genuine self-contradiction — and also what
  every UA-spoofing privacy extension produces for a real person. `strong`.
- **Missing `Sec-Fetch-*` on a modern browser.** Excellent signal; also what a
  stripping corporate proxy produces. `strong`.
- **Header order.** A real fingerprint a scraper cannot fix by copying a UA string;
  also reordered by any intermediary, and meaningless over HTTP/2. `weak`.
- **High request rate.** The signal people trust most and should trust least: a
  corporate NAT, a university, a mobile carrier's CGNAT pool and a VPN exit all
  present hundreds of real people as one address. Capped at `moderate`.
- **Datacenter IP ranges.** Where scrapers live — and where every consumer VPN, every
  corporate gateway, every Tor exit and iCloud Private Relay live too. `moderate`.
- **`navigator.webdriver` and friends.** Reported by JavaScript running inside the
  client, which is the one place an adversary has complete control. `moderate`.
- **A request for `/.env`.** No link points at it and no menu leads to it — but a URL
  is client-supplied text, and the client supplying it might be a security engineer
  testing their own site. `strong`, and a challenge rather than a closed door. A trap
  path is the case that *is* proven, and the difference is construction: a trap is
  unreachable by any sequence of user input, and a wordlist entry is merely unusual.

Writing a `deterministicBasis` string is required for `certain` evidence and enforced
at runtime outside production. It is a useful forcing function: if you cannot write
one, your evidence is `strong`.

---

## How a request flows through

```
  request
     │
     ├─ ignorePaths / allowlist ─────────────────► bypass, no detection at all
     │
     ├─ normalise facts        headers lowercased, path decoded once and resolved,
     │                         query into a null-prototype bag, everything bounded
     │
     ├─ actor state            bounded LRU: arrival ring, path hashes, UA count
     │
     ├─ DETECT   phase 1  cheap    pure string/header work, sequential, microseconds
     │           phase 2  io       concurrent, each under its own timeout
     │           phase 3  confirm  DNS — only if an identity was actually claimed
     │
     ├─ COMBINE  certain evidence short-circuits ─► confirmed-bot / verified-bot / human
     │           otherwise noisy-OR ─────────────► score 0–99, suspected-bot / unknown
     │
     ├─ DECIDE   first matching rule wins
     │              └─ SAFETY GUARD: terminal action + no proof ─► downgrade + record
     │
     └─ ACT      continue (tagged) │ respond │ drop
```

Each stage is separately callable. `assess()` reads the request and touches no
response, so it is safe to run over a log file. `decide()` is pure. `handle()` does
all three.

---

## What this library cannot do

- **Stop a determined, well-resourced adversary.** Someone running real Chrome through
  a residential proxy pool, at human pace, with correct headers, solving the proof of
  work, is indistinguishable from a person at the HTTP layer — because at that point
  the difference has stopped being technical. What this raises is the *cost*.
- **Prove somebody is human.** No signal here does that and none claims to. Proof of
  work proves CPU. `navigator.webdriver` proves what the client chose to report. The
  only conclusive human signal is your own application's assertion.
- **Replace authentication, authorisation or a WAF.** It classifies traffic. It is not
  a security boundary and nothing about it should be load-bearing for access control.
- **Ship IP intelligence.** Address-to-operator mappings go stale within weeks, and a
  stale mapping is a false positive with a long half-life. Bring your own, from a
  source you refresh and can audit.
- **Be right about a shared address.** Behind CGNAT, "one actor" is thousands of
  people. That is why the behavioural signals are capped where they are.
- **Escalate on a wordlist walk.** `probe-signature` reads one request at a time, so a
  scanner working through five hundred paths produces five hundred separate
  observations rather than a mounting case. That is the price of a detector that runs
  unchanged over a log file; enumeration over time is what `rate-anomaly`, `cadence`
  and `crawl-breadth` are for.

---

## Development

```bash
npm install
npm test          # 661 tests, including the full traffic corpus
npm run lint      # biome, the same rule set as the sibling projects
npm run typecheck # src + tests + examples, strict, exactOptionalPropertyTypes
npm run test:coverage  # the same tests, against a coverage ratchet
npm run build     # ESM + CJS + declarations
npm run demo      # protected site :9673 + live dashboard :9674
npm run demo:roles # the same dashboard behind roles: analyst :9684, operator :9685, admin :9686
npm run simulate  # eighteen curated scenarios against the demo
npm run simulate:corpus   # replay all 526 corpus cases over a real socket
npm run bench     # hot-path benchmark, median of several rounds
npm run corpus    # 526 shapes of real traffic against your policy
npm run example   # a minimal Express integration on :3000

npx @osqd/bothandlerjs replay access.log     # what your policy would have done
npx @osqd/bothandlerjs check                 # your policy against 526 shapes of real traffic
npx @osqd/bothandlerjs explain "curl/8.4.0"  # one request, and the evidence behind the verdict
```

Project layout:

```
src/
  core.ts            engine: assess -> decide -> handle
  cli.ts             replay, check, explain, robots, detectors
  metrics.ts         counters and Prometheus rendering
  robots.ts          robots.txt generation from a policy
  evidence.ts        certainty model and evidence combination
  config.ts          validation, defaults, client-IP resolution
  facts.ts           request normalisation
  state.ts           bounded per-actor behavioural memory
  detectors/         twenty detectors + the signature database
  policy/            rules, matcher, the safety guard, presets
  actions/           decision -> framework-neutral outcome
  challenge/         proof of work, signed tokens, the interstitial
  stores/            memory and Redis
  notify/            hub, sinks, redaction
  dashboard/         the operator dashboard: server, feed, page
  dashboard/client/  its browser code — a real module, bundled into the page
  adapters/          Express/Connect, Fastify, Koa, Fetch
  client/            browser-side signal script
  internal/          IP, crypto, UA, Aho-Corasick, LRU, DNS, HTTP
  corpus/            526 shapes of real traffic, with provenance, and the harness
                     that runs them against your configuration
demo/                the protected site and the live dashboard
scripts/simulate.ts  the traffic simulator
examples/            minimal integrations to copy from
```

---

## License

OSQD Non-Resale License, Version 1.0 — see [LICENSE](LICENSE).

---

## Security

See [SECURITY.md](SECURITY.md) for the threat model, what this library defends
against, and how to report a vulnerability.
