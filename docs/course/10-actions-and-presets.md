# Lesson 10 — Actions and presets

**Goal:** choose responses by what they cost somebody who did nothing wrong, then compare
your hand-written policy against the eight shipped ones.

← [Course](index.md) · Prev: [Rules](09-rules.md) · Next: [The challenge](11-the-challenge.md)

---

## Ten actions, ranked by who they hurt

That ranking is the useful one. Every action here will eventually be applied to somebody it
should not have been, so the question that matters is what that costs them.

| Action | Terminal | Costs a person |
| ------ | -------- | -------------- |
| `allow` | | nothing |
| `log` | | nothing |
| `tag` | | nothing |
| `delay` | | a moment |
| `rate-limit` | | a retry, if they are fast |
| `challenge` | | seconds, and a working browser |
| `custom` | | whatever you wrote |
| `redirect` | ✓ | their destination |
| `block` | ✓ | the page |
| `drop` | ✓ | the page, with no explanation |

The three marked terminal are the ones [the guard](04-the-guard.md) will not let rest on a
guess.

## The ones worth dwelling on

**`tag`** attaches the verdict to the **request** — `x-bot-verdict`, `x-bot-score`,
`x-bot-class`, `x-bot-certain`, `x-bot-reason` — so your own handlers can react without
re-running detection:

```js
app.get("/search", (req, res) => {
  const bot = req.headers["x-bot-verdict"] !== "unknown";
  res.json(bot ? cachedResults() : personalisedResults(req.user));
});
```

Response-side verdict headers are **off by default**, and should stay off: an `X-Bot-Score`
in the response is a live feedback signal for anyone tuning a scraper against you.

**`delay`** costs you almost nothing and costs a scraper everything, while a person notices
a pause and nothing else. Default 500 ms, capped at 10 s. It holds a connection open, so
prefer `rate-limit` under heavy concurrency.

**`rate-limit`** is the one action that **needs a shared store**. A limit of 100/minute
enforced independently by four replicas is a limit of 400/minute. [Lesson 14](14-scaling.md).

**`drop`** is the harshest thing here: the connection is destroyed with no response at all.
A person who hits it gets a browser error with nothing in it, cannot tell your site from an
outage, and has no way to contact you. **`block` with a `reason` is almost always better.**
Reserve `drop` for traffic you have already decided about.

## Custom actions

```js
import { BotHandler, defineHandler } from "@osqd/bothandlerjs";

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
  rules: [{ id: "shadow", match: { botClass: "scraper" }, action: "custom", params: { handler: "shadow-ban" } }],
});
```

`execute` returns `{ kind: "continue" }` — optionally with `requestHeaders`,
`responseHeaders` or `delayMs` — or `{ kind: "respond", status, headers, body }`, or
`{ kind: "drop" }`. It may be async.

**The guard does not apply to custom handlers.** It cannot know what yours does, so a
handler that denies service is a decision you own entirely. That is worth reading twice: it
is the one door out of the guarantee, and it is unlocked from the inside.

## The eight presets

A preset is not a black box. It is an array of the same rules you just wrote, exported and
readable:

```js
import { protectContent } from "@osqd/bothandlerjs";
console.log(protectContent());
```

| Preset | For | Terminal on |
| ------ | --- | ----------- |
| `monitor-only` | week one, always | nothing |
| `allow-crawlers` | publishers who want to be found | impersonators, scanners, traps |
| `protect-content` | a public content site | impersonators, scanners, traps |
| `decline-ai-training` | keeping search, declining trainers | + declared AI crawlers |
| `protect-data` | pricing, listings, inventory | + declared AI and SEO crawlers |
| `protect-api` | a JSON API | impersonators, scanners, traps |
| `protect-auth` | login, signup, checkout — **those routes only** | all proven automation |
| `under-attack` | during an incident, then off again | all proven automation |

```js
new BotHandler({ preset: "protect-content" });
```

## Compare yours to theirs

Print `protectContent()` beside your lesson 9 rules. You will find they are close — and the
differences are worth understanding:

- It has a `cleared-human-allow` rule first, which yours lacks. You will add the `isHuman`
  it depends on in [lesson 12](12-going-live.md).
- It challenges suspected traffic at `minScore: 70`, where yours only tags. That threshold
  is the number to move first when tuning.

## Three presets with a warning attached

**`protect-auth` must be mounted on auth routes only.** Site-wide it blocks your payment
webhooks, your own server-side renderer and every honest crawler — all proven automation,
which is exactly what it refuses. Correct on a login form, an outage anywhere else.

```js
app.use(botHandler(siteDetector));
app.use("/login", botHandler(authDetector));
app.use("/checkout", botHandler(authDetector));
```

**`protect-api` deliberately never challenges.** A proof of work is solved by a browser
running JavaScript, and an API client is not one — challenging your customers' integrations
breaks them while an attacker solves it once in headless Chrome. The escalation ladder there
is rate limiting.

**`under-attack` is temporary.** It challenges at `minScore: 40` and rate-limits
*everybody*, people included, because a uniform ceiling is the one mitigation that cannot
single anybody out. It is not DDoS protection — it runs after the connection is accepted —
and like `protect-auth` it refuses proven automation, so allowlist your webhooks *before*
you switch it on rather than during the incident.

## robots.txt, generated from the policy

Declining a crawler and not saying so is the worst of both worlds: it keeps coming, and you
get no credit for having a policy.

```js
import { declineAiTraining, robotsFromRules } from "@osqd/bothandlerjs";

const { robotsTxt, declined, served, unreadable } = robotsFromRules(declineAiTraining(), {
  disallowPaths: ["/internal/export.csv"],     // your trap paths belong here
  sitemap: "https://serif.example/sitemap.xml",
});
```

**Read `unreadable` before you publish.** It lists rules that could not be reflected — a
predicate match, or a rule scoped to a path (which a named `robots.txt` group cannot
express without turning the crawler away from the whole site). A generated file that
silently omits something you block is worse than none at all: it tells crawlers they are
welcome where they are not.

`served` is the other one to read: crawlers a later rule would decline but an earlier rule
serves. That is why `decline-ai-training` blocks the `ai` category yet leaves
`ChatGPT-User` out of the file — it is served by an earlier rule, and the file agrees with
the policy rather than contradicting it.

## Exercise

Serif's business decision: keep search engines, decline model trainers, and say so.

<details>
<summary>Answer</summary>

```js
import { BotHandler, declineAiTraining, robotsFromRules } from "@osqd/bothandlerjs";

const detector = new BotHandler({ preset: "decline-ai-training" });

const { robotsTxt, unreadable } = robotsFromRules(declineAiTraining(), {
  disallowPaths: ["/internal/export.csv"],
  sitemap: "https://serif.example/sitemap.xml",
});
if (unreadable.length > 0) console.warn("not reflected in robots.txt:", unreadable);

app.get("/robots.txt", (_req, res) => res.type("text/plain").send(robotsTxt));
```

The preset serves `ChatGPT-User`, `PerplexityBot`, `OAI-SearchBot`, `ClaudeBot`,
`Mistral-AI` and `DuckDuckBot` — a crawler fetching one page because a person asked about
it is a citation, not a corpus — and blocks the rest of the `ai` category with a body that
says why.

**`robots.txt` is the primary mechanism, not the rules.** The crawlers named here honour
it; the rules are what happens to the ones that do not.
</details>

## What you learned

- Rank actions by what they cost a person who did nothing wrong
- `tag` is the workhorse; `drop` is almost never right
- Custom handlers are outside the guard, deliberately
- Presets are readable arrays of rules, not black boxes
- Three presets carry warnings; read them before mounting
- Generate `robots.txt` from the policy, and read `unreadable` and `served`

## Reference

- [Actions](../policy/actions.md) · [Presets](../policy/presets.md) · [robots.txt](../policy/robots.md)
- [Choosing a policy](../start/choosing-a-policy.md)

Next: [The challenge](11-the-challenge.md).
