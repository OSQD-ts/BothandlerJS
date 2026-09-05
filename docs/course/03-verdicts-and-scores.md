# Lesson 3 — Verdicts, classes and scores

**Goal:** know which of the four descriptive fields to act on, and why reading the wrong
one is the most common integration bug.

← [Course](index.md) · Prev: [Proof and suspicion](02-proof-and-suspicion.md) · Next: [The guard](04-the-guard.md)

---

## Four fields, four questions

| Field | The question it answers |
| ----- | ----------------------- |
| `verdict` | What did we conclude? |
| `certain` | Is that conclusion **proof**? |
| `botClass` | What *kind* of client is it? |
| `score` | How suspicious is it, if we are only guessing? |

They are not four ways of saying the same thing, and rules that mix them up are where
policies go wrong.

## The verdicts

| Verdict | Meaning | Proven? |
| ------- | ------- | ------- |
| `confirmed-bot` | Self-declared, self-contradictory, or caught in a trap | yes |
| `verified-bot` | Crawler identity confirmed against an external authority | yes |
| `suspected-bot` | Probabilistic signals cleared `suspectThreshold` (default 60) | **no** |
| `human` | Positive evidence of a person | only if `certain` |
| `unknown` | Nothing conclusive. The resting state of ordinary traffic | — |

The two proven verdicts are different in *direction*, and that is the point:
`confirmed-bot` is usually a reason to act, `verified-bot` is usually a reason to allow.
Googlebot is a bot you want.

## The classes

`botClass` is orthogonal to the verdict. It answers "what is it?" rather than "how sure are
we?":

`human` · `verified-bot` · `declared-bot` · `automation` · `http-client` · `scanner` ·
`scraper` · `impersonator` · `unknown`

Most real policies key on `botClass`, because it maps to a business decision. "Rate-limit
scrapers, block scanners, allow verified crawlers, tag declared bots" is a policy about
classes, not verdicts.

## Do this

```js
const cases = [
  ["curl", { host: "serif.example", "user-agent": "curl/8.4.0", accept: "*/*" }],
  ["sqlmap", { host: "serif.example", "user-agent": "sqlmap/1.7.2#stable (https://sqlmap.org)" }],
  ["GPTBot", { host: "serif.example", "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)" }],
  ["python", { host: "serif.example", "user-agent": "python-requests/2.32.3", "accept-encoding": "gzip, deflate" }],
  ["Chrome", CHROME],
];

for (const [label, headers] of cases) {
  const a = await detector.assess(createFacts({ method: "GET", url: "/books", headers, ip: "203.0.113.10" }));
  console.log(
    label.padEnd(8),
    a.verdict.padEnd(14),
    a.botClass.padEnd(14),
    String(a.score).padStart(3),
    a.certain ? "proven" : "guess",
    a.identity ?? "",
  );
}
```

Give each case its own `ip` if you want them judged independently — otherwise they are all
the same [actor](07-actors.md) and later requests carry the earlier ones' history.

### What to notice

- `sqlmap` and `curl` are both `confirmed-bot` and both proven, but their **classes**
  differ — `scanner` and `http-client`. A policy that blocks scanners and tolerates HTTP
  clients needs the class, not the verdict.
- `GPTBot` carries an `identity`. That is what lets you write a rule about one named
  crawler, and what [lesson 6](06-identity.md) is about.
- Chrome is `unknown`, scoring 0. Ordinary traffic concludes nothing.

## Which field should a rule use?

**Prefer `botClass` for business decisions.** "What do I do about scrapers?" is a question
you can answer once.

**Use `certain: true` when you are about to withhold something.** It is the field that
means proof.

**Use `score` only for graded, recoverable responses** — a challenge threshold, a
rate-limit tier. Never as a licence to deny.

**Be careful with a bare `{ certain: true }`.** It matches a proven **human** too, and
challenging a customer you just vouched for is worse than useless. The shipped
`protect-data` preset spells this out by matching verdicts explicitly:

```js
{ id: "any-proven-automation-challenge",
  match: { verdict: ["confirmed-bot", "verified-bot"], certain: true },
  action: "challenge" }
```

## `confidence`, and what it is for

`confidence` is 0–1, and exactly 1 when `certain`. It is not a second score — it is how
much to trust the verdict. In lesson 1 the copied-User-Agent request scored 45 with
confidence 0.553: genuinely unsure, and the number says so.

Use it for logging and for triage in a dashboard. Do not build rules on it; `score` and
`certain` are what the policy layer matches on.

## Exercise

Write a table of what Serif should do with each class, before you know how to express it.
Just the decision:

| Class | What Serif does |
| ----- | --------------- |
| `verified-bot` | ? |
| `declared-bot` | ? |
| `scraper` | ? |
| `scanner` | ? |
| `impersonator` | ? |
| `http-client` | ? |
| `unknown` | ? |

<details>
<summary>A defensible answer</summary>

| Class | Serif | Why |
| ----- | ----- | --- |
| `verified-bot` | allow | Googlebot brings readers |
| `declared-bot` | tag | honest automation; let the app decide |
| `scraper` | rate-limit | bulk extraction, slowed rather than refused |
| `scanner` | block | proven, and looking for a way in |
| `impersonator` | block | forged an identity; proven by DNS |
| `http-client` | challenge | might be somebody's integration — do not refuse outright |
| `unknown` | allow | this is your readers |

Keep this. It is the policy you will write in [lesson 9](09-rules.md), and comparing it
with the shipped presets in [lesson 10](10-actions-and-presets.md) is the point of that
lesson.
</details>

## What you learned

- Verdict, class, certainty and score answer four different questions
- `botClass` is usually the right field for a business decision
- `certain` is the only field that should gate withholding something
- `{ certain: true }` alone also matches a proven human

## Reference

- [Verdicts, classes and scores](../concepts/verdicts.md)
- [Matching requests](../policy/rules.md) — every field a rule can read

Next: [The safety guard](04-the-guard.md) — what happens when a rule asks for more than its
evidence supports.
