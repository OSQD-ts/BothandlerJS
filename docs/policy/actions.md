# Actions

All ten, ordered by what each costs a client that turns out to be a person.

← [Documentation](../index.md) · [Policy](index.md)

---

That ordering is the useful one. Every action here will eventually be applied to somebody
it should not have been applied to, so the question that matters is what that costs them.

| Action | Terminal | Costs a person |
| ------ | -------- | -------------- |
| [`allow`](#allow) | | nothing |
| [`log`](#log) | | nothing |
| [`tag`](#tag) | | nothing |
| [`delay`](#delay) | | a moment |
| [`rate-limit`](#rate-limit) | | a retry, if they are fast |
| [`challenge`](#challenge) | | seconds, and a working browser |
| [`custom`](#custom) | | whatever you wrote |
| [`redirect`](#redirect) | ✓ | their destination |
| [`block`](#block) | ✓ | the page |
| [`drop`](#drop) | ✓ | the page, with no explanation |

The three marked terminal are the ones [the guard](../concepts/the-guard.md) will not let
rest on a guess.

The engine never touches a response object. It returns an `ActionOutcome` and the
[adapter](../integration/adapters.md) applies it — which is why the same policy works
identically on Express, Fastify, Koa and a Fetch runtime.

---

## `allow`

Serve it. Explicitly, and that is not the same as having no rule: an `allow` above your
other rules is how you say "this is fine, stop asking".

```ts
{ id: "verified-crawler-allow", match: { verdict: "verified-bot" }, action: "allow",
  reason: "Crawler identity confirmed against its operator's DNS or published ranges." }
```

`params.headers` is honoured, so an allow can still carry something to the response.

## `log`

Serve it, and record it. The whole of `monitor-only` is built from this.

```ts
{ id: "observe-suspected", match: { verdict: "suspected-bot" }, action: "log" }
```

## `tag`

Serve it, and attach the verdict to the **request** so your own handlers can react without
re-running detection: `x-bot-verdict`, `x-bot-score`, `x-bot-class`, `x-bot-certain`,
`x-bot-reason`.

```ts
app.get("/search", (req, res) => {
  const bot = req.headers["x-bot-verdict"] !== "unknown";
  res.json(bot ? cachedResults() : personalisedResults(req.user));
});
```

Response-side verdict headers are **off by default** (`exposeVerdictHeaders`). An
`X-Bot-Score` in the response is a live feedback signal for anyone tuning a scraper
against you.

## `delay`

Serve it, slowly. `params.delayMs`, default 500 ms, capped at 10 s.

```ts
{ id: "slow-suspects", match: { verdict: "suspected-bot" }, action: "delay",
  params: { delayMs: 1500 } }
```

Cheap for you and expensive for anything making thousands of requests, while a person
notices a pause and nothing else. It holds a connection open, so it is a poor choice under
heavy concurrency — prefer `rate-limit` there.

## `rate-limit`

A fixed window per [actor](../concepts/actors.md). Over the limit, the request is refused
with `429` and a `Retry-After`.

```ts
{ id: "scraper-ratelimit", match: { botClass: "scraper" }, action: "rate-limit",
  params: { limit: { max: 60, windowMs: 60_000 } } }
```

**This is the one action that needs a shared [store](../integration/stores.md).** A limit
of 100/minute enforced independently by four replicas is a limit of 400/minute. With the
default in-memory store it is per-instance, and the library will not pretend otherwise.

A fixed window rather than a sliding one: one round trip instead of several, and the extra
precision buys nothing for a mechanism whose job is to bound abuse rather than measure it.

## `challenge`

Serve a proof-of-work interstitial. Solving it grants a signed clearance cookie; the
`clearance` detector reads it on subsequent requests.

```ts
{ id: "suspected-challenge", match: { verdict: "suspected-bot", minScore: 70 },
  action: "challenge" }
```

Needs `challenge.secrets` configured — without it, a rule asking for one degrades to a
`tag` and says so through `onWarning`. See [the challenge](../challenge/index.md) for what
it does and does not buy.

Challenging an actor that already holds valid clearance is refused and warned about:
passing a challenge cannot change a proven verdict, so re-issuing would loop for ever.

## `custom`

Your own handler, registered by name.

```ts
import { defineHandler } from "bothandlerjs";

const shadowBan = defineHandler({
  id: "shadow-ban",
  description: "Serves an empty result set rather than an error",
  execute: ({ assessment }) => ({
    kind: "respond",
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ results: [] }),
  }),
});

new BotHandler({
  handlers: [shadowBan],
  rules: [{ id: "shadow", match: { botClass: "scraper" }, action: "custom",
            params: { handler: "shadow-ban" } }],
});
```

An `execute` returns one of three things: `{ kind: "continue" }` — optionally with
`requestHeaders`, `responseHeaders` or a `delayMs` — `{ kind: "respond", status, headers,
body }`, or `{ kind: "drop" }`. It may be async.

A handler named in a rule but not registered serves the request and warns. **The guard
does not apply to custom handlers** — it cannot know what yours does — so a handler that
denies service is a decision you own entirely.

## `redirect`

Terminal. `params.location` is required; without it the request is served and a warning is
raised.

```ts
{ id: "bots-to-api", match: { certain: true, botClass: "scraper" }, action: "redirect",
  params: { location: "/api/docs" } }
```

Useful for sending automation somewhere it can be served cheaply and correctly — a data
endpoint, a sitemap, a licensing page — rather than simply refusing it.

## `block`

Terminal. `403` by default with a plain-text body; `params.status` and `params.body`
override both.

```ts
{ id: "scanner-block", match: { botClass: "scanner", certain: true }, action: "block",
  params: { status: 403, body: "Automated scanning is not served here." },
  reason: "Proven scanner. Refused on proof, not on suspicion." }
```

The body reaches a person often enough to be worth writing. Say what happened and how to
reach you.

## `drop`

Terminal, and the harshest thing here: the connection is destroyed with no response at
all. What a port behind a dropping firewall looks like.

```ts
{ id: "denylisted", match: { detector: ["ip-intelligence"], certain: true }, action: "drop" }
```

Reserve it for traffic you have decided about — a denylist entry, a confirmed attack. A
person who hits this gets a browser error with nothing in it, cannot tell your site from an
outage, and has no way to contact you. `block` with a `reason` is almost always the better
answer.

## Related

- [The safety guard](../concepts/the-guard.md) — what happens when a guess asks for a terminal action
- [Presets](presets.md) — these actions, assembled
- [Adapters](../integration/adapters.md) — how an outcome becomes a response
