# Lesson 16 — Proving it, and the capstone

**Goal:** find out who your policy would hurt *before* it hurts them, then assemble
everything into a Serif you can defend.

← [Course](index.md) · Prev: [Extending it](15-extending.md)

---

## The question this library is organised around

*If I point this configuration at the actual internet, who gets hurt?*

Three tools answer it, and they answer different halves.

## `check` — against 548 shapes of real traffic

```bash
npx @osqd/bothandlerjs check --preset protect-content
```

```
  protect-content against 539 shapes of real traffic

  human            184 cases   178 allow, 3 tag, 3 challenge
  benign-bot       144 cases   86 tag, 48 block, 6 allow, 2 challenge, 2 rate-limit
  declared-bot      32 cases   18 tag, 9 block, 3 allow, 2 rate-limit
  unwanted-bot     109 cases   71 challenge, 16 allow, 11 rate-limit, 8 tag, 3 block
  hostile           37 cases   20 block, 9 allow, 7 challenge, 1 tag
  infrastructure    33 cases   14 challenge, 12 tag, 7 allow

  No case marked as a person was denied service.
```

The corpus holds 548 cases and this run reports 539, which is not a discrepancy: a case
naming a capability the configuration under test does not provide is *skipped* rather than
failed. The nine here need a marker probe or a site baseline, and judging a marker case
against a configuration that issues no markers would be a verdict about nothing. Turn those
sources on and the same command reports all 548.

**It exits non-zero if any case marked `human` is denied**, which is what makes it a CI step
rather than a report.

The corpus is 548 cases with provenance: 186 of them people — 30 browser profiles, 40 in-app
WebViews, Tor, screen readers, IE11, a car's infotainment screen, corporate proxies, CGNAT,
an author signing in at `/wp-login.php`. Header order is reproduced rather than invented, and
DNS is controlled rather than mocked away, so *"the operator's DNS disproves this"* and
*"our resolver was unhappy"* can be told apart.

`--audience human` shows only the part that matters. `--strict` also fails on differing
actions.

### Against *your* configuration

The corpus is a published entry point, not a test fixture:

```js
import { runCorpus } from "@osqd/bothandlerjs/corpus";

const scorecard = await runCorpus({
  create: ({ resolver, clock }) => new BotHandler({ ...serifConfig, resolver, clock }),
  assertActions: false,   // your actions are yours; the invariants are not
});

if (scorecard.falsePositives.length > 0) {
  throw new Error(`Serif's policy denies ${scorecard.falsePositives.length} people`);
}
```

Put that in your test suite. It runs offline and deterministically.

## `replay` — against traffic that is actually yours

The corpus knows what the internet looks like. Only your logs know what *your* visitors look
like.

```bash
npx @osqd/bothandlerjs replay /var/log/nginx/access.log --preset protect-content
```

```
  116 request(s) would have been DENIED, in 1 distinct kind(s). Read them.
  ─────────────────────────────────────────────────────────────────────
     116x  block by rule "scanner-block" — confirmed-bot, proven
          sqlmap/1.7.2#stable (https://sqlmap.org)
          [certain] self-identified: User-Agent identifies sqlmap
```

That block is the point of the exercise. If any of those is a person, the policy is wrong —
and you found out from a log file rather than from a support ticket.

**Prefer JSON Lines over CLF**, and the reason is the rule from [lesson 2](02-proof-and-suspicion.md):

> A header missing from a *record* is not a header missing from the *request*.

An nginx line carries the User-Agent and the Referer and nothing else. Detectors that reason
from absence would fire on everything, so `partialHeaders` marks a header-poor source and
they stand down. A CLF replay therefore **under-reports**, and its silence is not a clean
bill of health.

```js
createFacts({ method, url, headers, ip, partialHeaders: true });
```

## `explain` — one request, by ticket

```bash
npx @osqd/bothandlerjs explain "curl/8.4.0"
pbpaste | npx @osqd/bothandlerjs explain --preset protect-data
```

A User-Agent, a curl command out of devtools, or a raw header block. It runs as a **dry
run** — nothing recorded, so asking does not change the answer:

```js
const assessment = await detector.assess(facts, { record: false });
```

No counter moves, no actor state changes, no event fires. It has no history by construction,
so what it answers is *what would this look like as a first request* — which is what a
ticket is asking anyway.

## The order to use them in

1. **`explain`** — one request, when somebody complains
2. **`check`** — in CI, on every change
3. **`replay`** — before enforcing anything, over a real week
4. **`monitor-only` in production** — for a week, watching the dashboard

Step 4 is not optional and the first three do not replace it.

---

# Capstone: Serif

Everything from sixteen lessons, in one configuration.

```js
import express from "express";
import { BotHandler, RedisStore, declineAiTraining, robotsFromRules, renderTrapLink } from "@osqd/bothandlerjs";
import { botHandler } from "@osqd/bothandlerjs/adapters";

const store = new RedisStore(redis);
const proxy = { trustProxy: true, trustedProxies: ["10.0.0.0/8"] };   // lesson 12

const site = new BotHandler({
  preset: "decline-ai-training",            // lesson 10 — the business decision
  proxy,                                    // lesson 12 — the dangerous setting
  store,                                    // lesson 14 — nonces and rate limits
  shareConfirmations: true,                 // lesson 14 — proof travels
  actorKey: (facts) => facts.session ?? facts.ip,          // lesson 7
  isHuman: (facts) => Boolean(sessions.get(facts.session ?? "")?.authenticated),   // lesson 12
  allowlist: ["10.0.0.0/8"],                // monitors and CI
  ignorePaths: ["/healthz", "/metrics"],
  extraDetectors: [checkoutVelocity()],     // lesson 15
  extraSignatures: [partner],               // lesson 15
  challenge: {                              // lesson 11
    secrets: [process.env.SERIF_CHALLENGE_SECRET, process.env.SERIF_CHALLENGE_SECRET_PREVIOUS].filter(Boolean),
    contactHtml: '<p>Locked out? Email <a href="mailto:help@serif.example">help@serif.example</a>.</p>',
    translations: { "pt-BR": { lang: "pt-BR", title: "Verificando seu navegador" }, ja: { lang: "ja", title: "ブラウザーを確認しています" } },
  },
  rules: [                                  // lesson 9 — yours run before the preset's
    { id: "partner-allow", match: { identity: "serif-partner-sync" }, action: "allow",
      reason: "Our own nightly partner sync." },
    { id: "persistent-refusal", match: { minUnsolvedChallenges: 5 }, action: "block",
      reason: "Issued five challenges, finished none." },
  ],
  audit: { windowMs: 5 * 60_000, baselineMs: 60 * 60_000, minSamples: 50 },   // lesson 13
  onAnomaly: (a) => pager.send(a.severity, a.summary),
  onDowngrade: ({ decision }) => metrics.increment("bot.downgrade", { rule: decision.rule }),
  onWarning: (message) => log.warn({ message }, "bothandler"),
});

// Auth routes get their own policy, mounted only there.        lesson 10
const auth = new BotHandler({ preset: "protect-auth", proxy, store });

const app = express();
app.use(botHandler(site));
app.use("/login", botHandler(auth));
app.use("/checkout", botHandler(auth));

// Say out loud what the policy does.                            lesson 10
const { robotsTxt, unreadable } = robotsFromRules(declineAiTraining(), {
  disallowPaths: ["/internal/export.csv"],
  sitemap: "https://serif.example/sitemap.xml",
});
if (unreadable.length > 0) log.warn({ unreadable }, "not reflected in robots.txt");
app.get("/robots.txt", (_req, res) => res.type("text/plain").send(robotsTxt));

// A trap no person can reach.                                   lesson 8
app.get("/", (_req, res) => res.send(`<main>…</main>${renderTrapLink("/internal/export.csv")}`));

// Watch it.                                                     lesson 13
app.get("/internal/metrics", (_req, res) => res.type("text/plain").send(site.prometheus()));
await site.serveDashboard({ port: 9674, title: "serif", auth: { username: "ops", password: process.env.DASHBOARD_PASSWORD } });
```

And the test that stops it hurting anybody:

```js
import { runCorpus } from "@osqd/bothandlerjs/corpus";

it("never denies a person", async () => {
  const scorecard = await runCorpus({
    create: ({ resolver, clock }) => new BotHandler({ ...serifConfig, resolver, clock }),
    assertActions: false,
  });
  expect(scorecard.falsePositives).toEqual([]);
});
```

## Final exercise

Answer these without looking anything up. They are the whole course.

1. A client scores 99 from probabilistic signals. Can a rule block it? Why?
2. Your policy denies 4% of traffic. What do you check first?
3. `bothandler_downgrades_total` doubled after a deploy. What happened?
4. `challenge-solve-rate` is 96%. Is that good?
5. You add a detector that catches a scraper perfectly. What tier is its evidence?

<details>
<summary>Answers</summary>

1. **No.** The score is not what gates a terminal action — `certain` is. Ninety-nine
   probabilistic points are ninety-nine things a real person can trip, and the guard
   substitutes something recoverable. [Lesson 4](04-the-guard.md).

2. **Who the 4% are.** Run `replay` over the log and read every denial. A `denial-spike`
   anomaly is not evidence they were bots — it is evidence that something changed, and the
   expensive possibility is that it changed about people. [Lesson 13](13-operating-it.md).

3. **Your policy now asks for more than the evidence supports.** Either a rule changed, or
   the traffic did. The guard absorbed the difference, which is why nobody was wrongly
   refused — but the two have drifted apart and the number is telling you so.
   [Lesson 4](04-the-guard.md).

4. **No — it is the bad direction.** A proof of work is trivial for a browser and trivial
   for a competent scraper. When nearly everything challenged passes, the challenges are not
   filtering bots out, they are taxing people. [Lesson 13](13-operating-it.md).

5. **`strong`, almost certainly.** Ask whether you can write a `deterministicBasis`
   sentence explaining why no benign explanation exists. Unless the client *declared*
   itself, *contradicted* itself, walked into a *trap*, was *refuted by an external
   authority*, or committed a *protocol violation* — you cannot, and it is not certain.
   [Lesson 15](15-extending.md).
</details>

## Where to go now

- **[The threat model](../concepts/threat-model.md).** Read it before you promise anybody
  anything. It names the two rungs of the evasion ladder that defeat this library, and it is
  the most useful page in the documentation once you know how everything works.
- **[Design decisions](../design/decisions.md).** Fifteen choices with what each one cost.
- **[The reference](../index.md).** Thirty pages, one per question.

## What you learned in this course

- Proof and suspicion are different things, and only one of them may close a door
- Twenty detectors, each with a ceiling it may not exceed
- A name is a claim until an external authority confirms it
- Behaviour over time catches what a single request cannot, and stops at a paced scraper
- First match wins, and order is the policy
- Rank actions by what they cost somebody who did nothing wrong
- The challenge imposes cost; it proves neither identity nor humanity
- The client IP is the setting that is silent when it is wrong
- Alert on downgrades; read the score histogram before moving a threshold
- Proof travels between replicas; suspicion stays home
- If you cannot write why it admits no benign explanation, it is not certain
- Find out who your policy hurts before it hurts them

← [Back to the course](index.md)
