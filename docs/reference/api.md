# API

The methods on `BotHandler`, the entry points, and where each exported name is documented.

← [Documentation](../index.md)

---

## Entry points

| Import | Contains |
| ------ | -------- |
| `bothandlerjs` | the engine, detectors, presets, robots, stores, notifiers, challenge, dashboard |
| `bothandlerjs/adapters` | [Express, Fastify, Koa, Fetch](../integration/adapters.md) |
| `bothandlerjs/client` | the browser-side [client signals](../detection/client-signals.md) script |
| `bothandlerjs/corpus` | [`runCorpus`](../testing/corpus.md) and the cases |
| `bothandlerjs/cli` | the [command line](../testing/cli.md) entry point |

Zero runtime dependencies, ESM and CJS, types included.

---

## The request path

```ts
const assessment = await detector.assess(facts, { record: false });
const decision   = detector.decide(assessment);
const result     = await detector.handle(facts);   // both, plus the action applied
```

| Method | |
| ------ | - |
| `assess(facts, options?)` | runs detection. `{ record: false }` is a [dry run](../detection/index.md) |
| `decide(assessment)` | applies the [policy](../policy/index.md) and [the guard](../concepts/the-guard.md). Synchronous and pure |
| `handle(facts)` | assess + decide + produce an `ActionOutcome` |
| `createFacts(input)` | builds `RequestFacts` from method, url, headers, `rawHeaders`, ip |

`assess` and `decide` are separate on purpose: *what is this client* and *what should we do
about it* are different questions with different lifetimes. See [policy](../policy/index.md).

## The challenge

| Method | |
| ------ | - |
| `isChallengeEndpoint(facts)` | is this the verification POST? Adapters call it for you |
| `verifyChallenge(facts, body)` | verify a solution, grant clearance |
| `grantClearance(facts, level?)` | issue clearance directly — `"operator"` by default |

`grantClearance(facts, "operator")` is how your application vouches for an authenticated
person. See [the challenge](../challenge/index.md).

## Observation

| Method | |
| ------ | - |
| `on(event, handler)` | subscribe; returns an unsubscribe function |
| `metrics()` | structured snapshot |
| `prometheus(options?)` | text exposition format |
| `runAudit()` | run the [audit](../operations/audit.md) checks now |
| `audit` | the `TrafficAudit` object, with `summary()` |
| `serveDashboard(options?)` | start [the dashboard](../operations/dashboard.md) on its own port |
| `describeDetectors()` | id, description, cost and stage for each installed detector |

## Runtime changes

Each takes a trailing `{ by }` — see [runtime changes](../operations/runtime-changes.md).

| Method | |
| ------ | - |
| `updatePolicy(rules, ctx?)` | validated, atomic; cannot touch the guard |
| `updateGuard(settings, ctx?)` | its own method and its own event, deliberately |
| `updateRanges(name, entries, ctx?)` | allowlist, denylist, datacenter |
| `updateCrawlerRanges(id, entries, ctx?)` | one crawler's published ranges |
| `listRanges()` / `rangeEntries(name)` | what is loaded |
| `forgetActor(key, ctx?)` | drop one [actor's](../concepts/actors.md) memory |
| `clearActor(key, forMs, ctx?)` | treat an actor as cleared for a while |

## Inspection

`resolveIp`, `actorKeyFor`, `isAllowlisted`, `isIgnoredPath`, `policy`, `warn`.

`warn(message)` is public so warnings raised *outside* the engine — the fetch adapter, the
crawler-range refresher — reach the same `warning` event as everything else, rather than
only the `onWarning` callback.

---

## Where the exported names are documented

| Names | Page |
| ----- | ---- |
| `BotHandler`, `createFacts`, `resolveConfig`, `validateRules`, `ConfigError` | [Configuration](configuration.md) |
| `CERTAINTY_WEIGHT`, `combineEvidence`, `noisyOr`, `sortEvidence`, `weightOf` | [Evidence](../concepts/evidence.md) |
| `VERDICTS`, `BOT_CLASSES` | [Verdicts](../concepts/verdicts.md) |
| `defaultDetectors`, every `*Detector` factory, `Detector`, `Evidence` | [Detectors](../detection/detectors.md), [writing one](../detection/writing-a-detector.md) |
| `BOT_SIGNATURES`, `BotSignature`, `BotCategory` | [Signatures](../detection/signatures.md) |
| `forwardConfirmedReverseDns`, `cachingResolver`, `nodeDnsResolver`, `PUBLISHED_CRAWLER_RANGES`, `refreshCrawlerRanges`, `startCrawlerRangeRefresh` | [Verification](../detection/verification.md) |
| `PRESETS`, every preset function, `Rule`, `MatchSpec`, `Decision` | [Rules](../policy/rules.md), [presets](../policy/presets.md) |
| `defineHandler`, `CustomHandler`, `ActionOutcome`, `ACTION_NAMES`, `TERMINAL_ACTIONS` | [Actions](../policy/actions.md) |
| `generateRobotsTxt`, `robotsFromRules`, `agentFor` | [robots.txt](../policy/robots.md) |
| `ChallengeService`, `ChallengeOptions`, `ChallengeCopy`, `parseAcceptLanguage`, `pickTranslation` | [The challenge](../challenge/index.md), [localisation](../challenge/localisation.md) |
| `MemoryStore`, `RedisStore`, `BotHandlerStore` | [Stores](../integration/stores.md) |
| `consoleNotifier`, `webhookNotifier`, `slackNotifier`, `notifyJsNotifier`, `Notifier` | [Notifications](../operations/notifications.md) |
| `Metrics`, `toPrometheus`, `SCORE_BUCKETS`, `DURATION_BUCKETS_MS` | [Metrics](../operations/metrics.md) |
| `TrafficAudit`, `DEFAULT_CHECKS`, `AuditCheck`, `TrafficAnomaly` | [The audit](../operations/audit.md) |
| `startDashboard`, `createDashboardHandler`, `renderDashboardPage`, `Dashboard*` | [The dashboard](../operations/dashboard.md) |
| `ActorRegistry`, `ActorState`, `ActorSummary` | [Actors](../concepts/actors.md) |
| `renderTrapField`, `TRAP_FIELD_SOURCE` | [Detectors](../detection/detectors.md), [adapters](../integration/adapters.md) |
| `ClientSignals`, the client script | [Client signals](../detection/client-signals.md) |

### The utilities

Exported because they are useful on their own and because a detector you write will want
them: `IpRangeSet`, `parseIp`, `parseCidr`, `cidrContains`, `normalizeIp`, `formatIp`,
`isSpecialUse`, `networkKey`, `SPECIAL_USE_RANGES`; `parseUserAgent`, `claimsBrowser`,
`sendsModernHeaders`; `parseCookies`, `serializeCookie`; `MultiPatternMatcher`, `TtlLru`,
`Emitter`, `ManualClock`, `systemClock`.

`ManualClock` and a stub `DnsResolver` are what make the [corpus](../testing/corpus.md)
deterministic, and they will do the same for your tests.

## Related

- [Configuration](configuration.md) — every constructor option
- [Detection](../detection/index.md) — what `assess` actually runs
- [Policy](../policy/index.md) — what `decide` actually applies
