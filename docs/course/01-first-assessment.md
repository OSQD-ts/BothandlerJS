# Lesson 1 — Your first assessment

**Goal:** turn an HTTP request into a verdict, and understand every field that comes back.

← [Course](index.md) · Next: [Proof and suspicion](02-proof-and-suspicion.md)

---

## The two calls

Everything in this library is downstream of two functions.

`createFacts` normalises a request into a `RequestFacts` — headers lowercased, path decoded
once and resolved, query into a null-prototype bag, everything length-bounded. `assess`
reads those facts and returns an `Assessment`.

Neither touches a response. That is why you can run `assess` over a log file, and why the
rest of this course can happen in a plain script with no server.

## Do this

`serif/lesson-01.mjs`:

```js
import { BotHandler, createFacts } from "@osqd/bothandlerjs";

const detector = new BotHandler();

const request = createFacts({
  method: "GET",
  url: "/books/1",
  headers: { host: "serif.example", "user-agent": "curl/8.4.0", accept: "*/*" },
  ip: "203.0.113.10",
});

const assessment = await detector.assess(request);

console.log("verdict   ", assessment.verdict);
console.log("class     ", assessment.botClass);
console.log("score     ", assessment.score);
console.log("certain   ", assessment.certain);
console.log("confidence", assessment.confidence);
for (const piece of assessment.evidence) {
  console.log(`  [${piece.certainty}] ${piece.detector}: ${piece.summary}`);
}
```

```bash
node lesson-01.mjs
```

### Checkpoint

```
verdict    confirmed-bot
class      http-client
score      100
certain    true
confidence 1
  [certain] self-identified: User-Agent identifies curl
```

If you got that, the library is installed and working.

## What each field means

| Field | |
| ----- | - |
| `verdict` | the conclusion: `confirmed-bot`, `verified-bot`, `suspected-bot`, `human`, `unknown` |
| `botClass` | *what kind* of client: `http-client`, `scraper`, `scanner`, `impersonator`, `declared-bot`, `verified-bot`, `automation`, `human`, `unknown` |
| `score` | suspicion, 0–100, from probabilistic signals only |
| `certain` | whether at least one piece of **proof** fired. **This, not the score, is the important one** |
| `confidence` | how much to trust the verdict, 0–1; exactly 1 when `certain` |
| `evidence` | every bot-pointing observation, strongest first |
| `humanEvidence` | every person-pointing observation; these *subtract* |
| `actor` | who this client is and what has been seen from them — [lesson 7](07-actors.md) |
| `requestId` | random per request, safe to log |
| `durationMs` | time spent in detection |

Note what happened above: `curl` did not get a score of 100 because many signals agreed.
It got `certain: true` because the client **said** it was curl, and the score follows from
proof rather than the other way round.

## Now try a real browser

Replace the headers with a full Chrome set — the Client Hints, the Fetch Metadata, the
negotiation headers:

```js
const CHROME = {
  host: "serif.example",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "accept-encoding": "gzip, deflate, br",
  "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};
```

Also print the human evidence:

```js
for (const piece of assessment.humanEvidence) {
  console.log(`  (human) [${piece.certainty}] ${piece.detector}: ${piece.summary}`);
}
```

### Checkpoint

```
verdict    unknown
class      unknown
score      0
certain    false
confidence 1
  (human) [weak] browsing-coherence: Fetch Metadata, Client Hints and negotiation headers are all present and mutually consistent
```

**`unknown` is the correct answer for a person**, and it is the resting state of ordinary
traffic. The library does not claim to have proved a human — it has nothing conclusive, and
says so. Only your own application can assert that somebody is a person, which you will do
in [lesson 12](12-going-live.md).

## Exercise

Take the Chrome headers and delete everything except `host`, `user-agent` and
`accept: */*` — a scraper that copied a User-Agent string and nothing else. Assess it.

<details>
<summary>Checkpoint</summary>

```
verdict    unknown
class      unknown
score      45
certain    false
confidence 0.553
  [moderate] header-integrity: Client claims to be a browser but sent no Accept-Language header
  [moderate] header-integrity: Client claims to be a browser but sent no Accept-Encoding header
  [weak] accept-signature: Client claiming a browser sent Accept: */* with no Fetch Metadata to explain it
```

Three signals, a score of 45, and still `unknown` — not enough to call it a bot, and
nowhere near enough to refuse it. `confidence` dropped to 0.553, which is the library
saying it is genuinely unsure.

Notice what it did **not** do: claim to be certain. A copied User-Agent is suspicious and
is not proof, and lesson 2 is about why that distinction is the whole design.
</details>

## Common mistake

**Passing a forwarded address as `ip`.** `createFacts` wants the **socket** address; the
forwarded chain is resolved separately and carefully, because getting it wrong lets clients
pick their own identity. [Lesson 12](12-going-live.md) covers it, and it is the single
most consequential setting in the library.

## What you learned

- `createFacts` + `assess` is the whole read path, and neither touches a response
- Five fields describe a client, and `certain` is the one that matters most
- `unknown` is what ordinary human traffic looks like
- Proof and suspicion arrive by different routes

## Reference

- [How detection works](../detection/index.md) — the pipeline behind `assess`
- [Verdicts, classes and scores](../concepts/verdicts.md)
- [Configuration](../reference/configuration.md) — every constructor option

Next: [Proof and suspicion](02-proof-and-suspicion.md) — the idea the rest of the course
depends on.
