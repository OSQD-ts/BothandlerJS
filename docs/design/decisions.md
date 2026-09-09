# Design decisions

The choices that shaped the library, and what each one costs.

← [Documentation](../index.md)

---

Everything here is a trade rather than a free win. They are recorded together so that a
future change can weigh what it is undoing.

---

## Proof and suspicion are separate compartments

**The decision.** Evidence is tiered. `certain` short-circuits to a verdict; everything else
combines by noisy-OR into a 0–99 score. They never mix, and only the first can close a door.

**Why.** Every signal that catches sophisticated automation is probabilistic, and every one
has a population of real people who trip it. The usual answer — add the signals up, block
above a threshold — is exactly the mistake: points do not compose into proof. Two unrelated
suspicions about an unusual but entirely real browser reach 100 as readily as two
well-founded ones, and the people who get caught are disproportionately the ones with the
strongest reasons for their unusual setup.

**The cost.** Sophisticated scrapers that trip four probabilistic signals are still not
blocked. That is the intended behaviour, and it is why the [challenge](../challenge/index.md)
exists as a ceiling for suspicion.

See [evidence](../concepts/evidence.md).

## The guard runs after rule selection, not inside a rule

**The decision.** A separate pass, after the first matching rule is chosen, that replaces a
terminal action when the verdict is not proven.

**Why.** Anywhere else it can be forgotten. Inside a rule it has to be written correctly by
every author of every rule, including at 3am during an incident. After selection it cannot
be forgotten in a rule, worked around by a clever predicate, or bypassed by someone who has
not read the documentation. Relaxing it is one explicit, greppable setting.

**The cost.** A rule can say `block` and get `challenge`, which surprises people until they
read `bothandler_downgrades_total`. That surprise is the feature.

See [the guard](../concepts/the-guard.md).

## No argument from absence may ever be `certain`

**The decision.** A header missing from the facts never produces proof — including protocol
violations that would otherwise qualify.

**Why.** A header missing from a *record* is not a header missing from the *request*. A
caller building facts from a log line, a WAF event or a partial adapter would otherwise
manufacture proof against every request in the file. An HTTP/1.1 request with no `Host`
violates RFC 9112 as plainly as anything on the certain list, and it is deliberately not
proven here.

**The cost.** Some genuinely conclusive observations are demoted to `strong`. Worth it: the
failure mode it prevents is silent and enormous.

## `deterministicBasis` is required in writing

**The decision.** `certain` evidence must carry a written explanation of why it admits no
benign explanation; enforced at runtime outside production, a warning inside it.

**Why.** It is a forcing function. If you cannot write the sentence, your evidence is
`strong`. Nearly every case where somebody wanted to mark something `certain` has failed at
this step, which is the point.

**The cost.** Slightly more ceremony to write a detector. The warning-not-throw behaviour in
production means a third-party detector with a missing basis cannot take a live site down.

## The engine never touches a response object

**The decision.** `assess` returns an `Assessment`, `decide` returns a `Decision`, `handle`
returns an `ActionOutcome`. Adapters apply it.

**Why.** The same policy then behaves identically on Express and on a Worker; the engine is
testable without a server; `assess()` is safe to run over a log file; and the
[corpus](../testing/corpus.md), the [request tester](../operations/dashboard.md) and
[`explain`](../testing/cli.md) all become possible for free.

**The cost.** One more layer, and a new framework needs thirty lines of adapter.

## Nothing may put an unbounded await on the request path

**The decision.** `io` detectors run concurrently under a timeout, and a `cheap` detector's
promise is timed out too. Event handlers and notification sinks are never awaited. The
[audit](../operations/audit.md) runs on a timer, not in-band. `shareConfirmations` reads the
store once per actor per instance, unawaited.

**Why.** This code runs inline on every request to the site it protects. A slow resolver, a
wedged webhook or a Redis failover must cost latency, not availability.

**The cost.** Detection is sometimes less complete than it could be — a timed-out detector
simply does not contribute. Correct: a bot filter that fails closed is an outage with extra
steps.

## Behavioural state is process-local; confirmations are not

**The decision.** Rates, cadence, path breadth and UA history live in memory per process.
`shareConfirmations` lets a *proven* verdict cross replicas.

**Why.** A round trip per request would buy accuracy for signals that are only ever allowed
to raise suspicion. A confirmation is not one of those: it is a fact about the client rather
than a judgement about it. **Proof travels; suspicion stays home.**

**The cost.** Behind four replicas each sees a quarter of an actor's traffic and is
correspondingly less sure. The right trade for something that cannot close a door on its own.

See [stores](../integration/stores.md).

## Everything client-keyed is a bounded LRU

**The decision.** 20,000 actors, 32 arrival timestamps, 64 path *hashes*, 4 User-Agents.
Every cache has a TTL and a ceiling.

**Why.** An unbounded map keyed by anything a client controls is a remote OOM.

**The cost.** `requestsWithin` saturates at 32 and reports `undercounted: true` rather than a
true rate. Deliberate — that series describes an actor cheaply, and exact counting belongs to
[`rate-limit`](../policy/actions.md#rate-limit), which uses the store.

## No IP intelligence, and no crawler ranges, ship with the library

**The decision.** `datacenterRanges` and `crawlerRanges` are empty. What ships is the *URL*
each crawler operator publishes.

**Why.** A range baked into a release is wrong by the time somebody installs it, and being
wrong here means verifying whoever has since been handed the address. A stale mapping is a
false positive with a long half-life.

**The cost.** `ip-intelligence` does nothing until you supply data, and crawler verification
by address needs an opt-in refresher that makes outbound requests.

See [verification](../detection/verification.md).

## Client signals are capped at `moderate`, permanently

**The decision.** Anything reported by JavaScript running in the client can never exceed
`moderate`, whatever it says.

**Why.** It is the one place an adversary has complete control. `navigator.webdriver`
proves what the client *chose to report*.

**The cost.** A genuinely conclusive-looking signal contributes modestly. That is the correct
weight for a witness the defendant controls.

See [client signals](../detection/client-signals.md).

## One root cause is counted once

**The decision.** Evidence may declare a `family`; within a family the strongest observation
is taken instead of compounding.

**Why.** Noisy-OR is only sound over independent signals. A corporate proxy that strips
`Sec-Fetch-*` also strips the Client Hints and the `Accept-Language`, so three detectors fire
about one person behind one appliance and the arithmetic reads their agreement as
corroboration when it is an echo.

**The cost.** Slightly lower scores on the traffic that should have them. A scraper that
copied a User-Agent and nothing else scores 66 rather than 91 — still comfortably
`suspected-bot`, still challenged.

## Zero runtime dependencies

**The decision.** The library imports nothing but `node:` builtins, and CI fails if that
stops being true. `RedisStore` describes the commands it needs structurally and imports
neither client.

**Why.** Nothing here can hand your project a transitive advisory, an install script, or a
version conflict with something you already run — for a package that sits on every request.

**The cost.** More code written here: an IP parser, an Aho–Corasick matcher, an LRU, an
emitter. All of them are exported, so at least they are useful twice.

## The dashboard client is built, not a template literal

**The decision.** 21 typed modules, esbuild-bundled into `client.generated.ts` at build time.

**Why.** It was a 2,836-line template literal, with no type checking, no linting and no
tests — inside a string, where a stray backtick in a CSS comment silently terminates the
program.

**The cost.** A build step, and a generated file in the tree. Worth it the first time the
type checker catches something.

## The corpus is a published entry point, not a test fixture

**The decision.** `@osqd/bothandlerjs/corpus` ships `runCorpus` and all 548 cases.

**Why.** The claims in this documentation are only worth anything if you can check them
against *your* configuration. A corpus locked inside the test suite proves things about the
library's own presets and nothing about yours.

**The cost.** Package size, and a public API surface that now has to stay stable.

See [the corpus](../testing/corpus.md).

## The benchmark measures ratios, not microseconds

**The decision.** Every budget is a multiple of a reference loop measured in the same
process, seconds earlier.

**Why.** A committed baseline in microseconds is a statement about the machine that produced
it. CI runners are shared, throttled and re-provisioned; a suite that fails for reasons
unrelated to the code is a suite people disable. A runner half the speed of a laptop runs
both halves at half speed and the ratio is unchanged.

**The cost.** The numbers are less immediately meaningful. Budgets are set at roughly double
current cost — a guard, not a tripwire.

## Related

- [Evidence](../concepts/evidence.md) · [The guard](../concepts/the-guard.md) · [Threat model](../concepts/threat-model.md)
- [Configuration](../reference/configuration.md) — where these show up as settings
