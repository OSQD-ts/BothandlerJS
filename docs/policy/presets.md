# Presets

Eight rule sets to read, adapt and own.

← [Documentation](../index.md) · [Policy](index.md)

---

A preset is not a black box. It is an array of [rules](rules.md) — the same ones you would
write — exported from `src/policy/presets.ts`, each carrying an `id` and a `reason`. Print
one, change one line, keep the rest:

```ts
import { BotHandler, protectContent } from "@osqd/bothandlerjs";

new BotHandler({
  rules: protectContent().filter((rule) => rule.id !== "http-client-challenge"),
});
```

Or name it and be done:

```ts
new BotHandler({ preset: "protect-content" });
```

Every preset assumes the default `strict` [guard](../concepts/the-guard.md), which is why
even the harshest of them is safe to try: a rule asking to block cannot deny an unproven
request. **Choose a preset for the shape of the policy; the guard decides how far it is
allowed to go.**

| Preset | For | Terminal on |
| ------ | --- | ----------- |
| [`monitor-only`](#monitor-only) | week one, always | nothing |
| [`allow-crawlers`](#allow-crawlers) | publishers who want to be found | impersonators, scanners, traps |
| [`protect-content`](#protect-content) | a public content site | impersonators, scanners, traps |
| [`decline-ai-training`](#decline-ai-training) | keeping search, declining trainers | + declared AI crawlers |
| [`protect-data`](#protect-data) | pricing, listings, inventory | + declared AI and SEO crawlers |
| [`protect-api`](#protect-api) | a JSON API | impersonators, scanners, traps |
| [`protect-auth`](#protect-auth) | login, signup, checkout — **those routes only** | all proven automation |
| [`under-attack`](#under-attack) | during an incident, then off again | all proven automation |

---

## `monitor-only`

Three rules, no action heavier than `log`. Nothing is ever withheld from anybody.

```ts
new BotHandler({ preset: "monitor-only" });
```

**Run this first, for at least a week, on real traffic.** Every bot policy that has caused
an outage was deployed straight to enforcement by someone who was sure they knew what
their traffic looked like. Watch the [dashboard](../operations/dashboard.md), find the
integration you forgot about, and then choose a real preset.

## `allow-crawlers`

Allows more than it stops, by name. Verified crawlers first; declared benign automation —
link unfurlers, feed readers, uptime monitors — allowed rather than merely tolerated; and
the last rule tags everything else, so nothing is withheld at all.

Reach for it when a bot policy has already cost you traffic, or when the site's whole
purpose is to be indexed, quoted and shared. The cost is honest: bulk extraction is
rate-limited rather than challenged, so a determined scraper gets your content. On a site
that wants to be read that was always true; what this refuses to do is trade away your
search traffic to make it slightly less true.

## `protect-content`

The sensible default for a public site. Keeps the crawlers that bring traffic, slows the
ones that only take it, challenges what is probably automated, blocks what has proven
itself.

Two rules are worth knowing before you copy it. `http-client-challenge` challenges bare
HTTP clients rather than blocking them — plenty of those are your own integrations.
`suspected-challenge` fires at `minScore: 70`, which is the number to move first if you
are seeing too much or too little.

## `decline-ai-training`

Keep the search engines. Decline the model trainers.

The split it draws is the one the AI crawlers publish themselves. A crawler collecting a
training corpus and a crawler fetching one page because a person asked about it are
different jobs, often from the same operator under different product tokens.
`ChatGPT-User`, `PerplexityBot`, `OAI-SearchBot`, `ClaudeBot`, `Mistral-AI` and
`DuckDuckBot` are served and tagged; the rest of the `ai` category is blocked with a body
that says so.

**`robots.txt` is the primary mechanism, not this.** The crawlers named here honour it, and
a rule that blocks a crawler nobody told is load with no compliance. Generate the file from
the policy and publish it — see [robots.txt](robots.md):

```ts
import { declineAiTraining, robotsFromRules } from "@osqd/bothandlerjs";
const { robotsTxt } = robotsFromRules(declineAiTraining(), { sitemap: "https://example.com/sitemap.xml" });
```

## `protect-data`

For an application whose value is in its data. Like `protect-content`, plus: AI and SEO
crawlers are blocked on declaration, all proven automation is challenged, and
`/api/` and `/search` carry a 120/minute ceiling that applies to everyone equally.

The `any-proven-automation-challenge` rule matches on **verdicts** rather than bare
`{ certain: true }` — which would also match a proven human, and challenging a customer you
just vouched for is worse than useless. That subtlety is worth carrying into your own
rules.

## `protect-api`

One difference drives the whole shape: **a challenge is useless here.** A proof-of-work
interstitial is solved by a browser running JavaScript, and an API client is not one.
Challenging your customers' integrations does not slow an attacker down; it breaks the
integrations and leaves the attacker to solve it once in a headless browser. So the
escalation ladder is rate limiting.

The second difference is about what detection is *for* on an API. Your authentication is
the control that matters and already knows who the caller is. This preset tags everything
so your handlers can combine a verdict with a key, a plan and a quota; it does not try to
be the access control. A bare HTTP client is the normal case here, so the rule that
challenges one on a content site is deliberately absent.

## `protect-auth`

**Mount this on those routes only.**

```ts
app.use("/login", botHandler(authDetector));
app.use("/checkout", botHandler(authDetector));
```

Applied site-wide it blocks your payment webhooks, your own server-side renderer and every
honest crawler you have — all proven automation, which is exactly what this refuses. That
is correct on a login form and an outage anywhere else. The [corpus](../testing/corpus.md)
catches it; the symptom otherwise is a support ticket about missing orders three days
later.

The unusual choice is `delay` on merely-suspected traffic: 250 ms is imperceptible to a
person filling in a form and ruinous to a credential stuffer working through a list — and,
unlike a challenge, it excludes nobody.

## `under-attack`

A deliberately impatient posture for an incident. Everything proven is refused, suspicion
is challenged at `minScore: 40`, and *everyone* — people included — is held to 30 requests
a minute, because a uniform ceiling is the one mitigation that cannot single anybody out.

Three things to be clear about first.

**It is temporary.** The low threshold will interrupt real people on unusual browsers.
Put it behind a switch you can flip without a deploy — `updatePolicy()` and the
[dashboard's editor](../operations/runtime-changes.md) exist for this.

**It still cannot deny anyone on a guess.** The guard applies here as everywhere. An
incident is precisely when people reach for `falsePositivePolicy: "aggressive"`, and
precisely when the population getting caught is at its most unusual.

**It is not DDoS protection.** This runs in your process, after the connection is
accepted. Volume that hurts at the network layer needs handling at the network layer;
what this reduces is the *usefulness* of the traffic to whoever is sending it.

And the practical warning the corpus makes concrete: like `protect-auth`, this refuses
proven automation, so your own webhooks, health probes and renderer are refused too —
thirteen of the corpus's infrastructure cases are. Allowlist their addresses *before* you
switch it on, not during the incident when you notice.

## Choosing between them

By name, for config-driven setups:

```ts
import { PRESETS, type PresetName } from "@osqd/bothandlerjs";
const rules = PRESETS[process.env.BOT_PRESET as PresetName]();
```

Whichever you pick, run it against the corpus before it reaches production — the run tells
you which of your own traffic the policy refuses:

```bash
npx @osqd/bothandlerjs check --preset protect-auth
```

## Related

- [Rules](rules.md) — the grammar these are written in
- [Actions](actions.md) — what each rule can ask for
- [Choosing a policy](../start/choosing-a-policy.md) — the decision, start to finish
- [The corpus](../testing/corpus.md) — 526 cases, including the ones these presets get wrong
