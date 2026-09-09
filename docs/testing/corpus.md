# The traffic corpus

548 cases, 1,235 requests, 12,802 header lines, 58 categories of real web traffic — and a
harness that runs them against *your* configuration.

← [Documentation](../index.md) · [Testing](index.md)

---

## Why it exists

Every claim in this documentation about what detection catches, what a preset does, and who
a policy hurts is measured on this corpus rather than asserted. It is also the reason the
[guard](../concepts/the-guard.md) can be defended concretely: "no case marked as a person is
denied service" is a test that runs, not a design intention.

```bash
npm run corpus                          # the protect-content preset
npm run corpus -- --preset protect-data
npm run corpus -- --audience human --verbose
```

```
  monitor-only     539/539 cases pass  ·  0 false positives
  protect-content  539/539 cases pass  ·  0 false positives
  protect-data     538/539 cases pass  ·  0 false positives
  protect-auth     524/539 cases pass  ·  0 false positives
```

539 rather than 548 because nine cases name a source this configuration does not provide —
a marker probe or a site baseline — and a verdict about a marker from a handler that issues
none is a verdict about nothing. Those are *skipped*, and named, rather than failed.

The two strict presets do not pass everything, and **the gap is the documentation rather
than a defect**: [`protect-auth`](../policy/presets.md#protect-auth) blocks proven
automation, and the fifteen cases it fails are your payment webhook, your own server-side
renderer, and your orchestrator's health probes — correct on a login route, an outage
anywhere else. That is why the preset says to mount it on those routes only, and why the
corpus keeps the receipts.

## What is in it

| Audience | Cases | Examples |
| -------- | ----: | -------- |
| **human** | 186 | 30 browser profiles across Chromium, Gecko and WebKit · desktop, mobile, tablet, console, television · 40 in-app WebViews (Instagram, TikTok, WeChat, KakaoTalk, LINE, VK, banking and airline apps) · Electron desktop apps · Tor, `resistFingerprinting`, Sec-GPC · Lynx, w3m, screen readers · IE11, Android 4.4, a car's infotainment screen · corporate proxies, carrier transcoders, CGNAT, iCloud Private Relay · an author signing in at `/wp-login.php` and a developer searching a docs site for SQL syntax |
| **benign-bot** | 144 | Googlebot and Bingbot verified by DNS · 30 regional crawlers (Naver, Seznam, Coc Coc, Sogou, 360, Shenma, Qwant, Mojeek) · Google's and Microsoft's specialist fleets · 12 link unfurlers · monitoring · feed and podcast clients · academic and archival crawlers · ad verification · email link scanners |
| **declared-bot** | 32 | The AI fleet split by job — training, search, fetch-for-a-user — plus an agentic browser |
| **unwanted-bot** | 116 | SEO and market-intelligence crawlers · **50 HTTP clients in their real header orders**, across Python, Node, JVM, Go, Rust, PHP, Ruby, .NET, Perl · headless runtimes · fabricated User-Agents from a randomiser (Chrome on an iPhone, Windows and macOS at once, Firefox on WebKit) |
| **hostile** | 37 | Forged Googlebot four ways · scanners · credential stuffing · traps · protocol abuse and request-smuggling framing · forwarding-header injection · wordlist probes for `/.env`, `/.git`, JNDI and TRACE · traversals spelled in percent-encoding and encoded twice over · open-proxy probing |
| **infrastructure** | 33 | CDN origin pulls (Cloudflare, Fastly, Akamai, CloudFront) · API gateways and service meshes · k8s and ELB probes · webhooks · browser prefetch |

Every request is built the way the client actually builds it — the Client Hints block, the
Fetch Metadata group, `Priority`, a cookie jar from somebody who has genuinely used the web
(`_ga`, `_fbp`, `__cf_bm`, a TCF consent string), cache validators on a revisit, and the
conditional long tail: `Sec-GPC`, `Save-Data`, `Sec-Purpose: prefetch`, `Early-Data`,
`Sec-CH-Prefers-Color-Scheme`, the Network Information hints. 155 requests carry cookies.
Every case records **provenance**, enforced by a test.

## The guarantee, checked rather than argued

Every case marked `human` carries an automatic `neverAction: ["block", "drop", "redirect"]`,
enforced by the harness whatever the case's own expectations say, and asserted **for every
request of a sequence** — because a person denied on request seven is still a person denied.

There is exactly one documented exemption, and it is *counted rather than hidden*: a
listener tapping a link inside a podcast app, whose software sends the same
crawler-convention User-Agent it uses to fetch feeds. The guarantee is about guesses, and a
client that announces itself automated is not a guess. The scorecard lists every such case
with a written reason.

## Two details that make it honest

**Header order is reproduced, not invented.** Chromium emits `Host, Connection, sec-ch-ua…,
User-Agent, Accept, Sec-Fetch-*, Accept-Encoding, Accept-Language, Priority`; Gecko leads
with identity and closes with Fetch Metadata and `TE`; WebKit interleaves them.
`python-requests` sending `Accept-Encoding` before `Accept` is only a signal if the corpus
gets this right.

**DNS is controlled, not mocked away.** Each case declares its answers, so *"the operator's
DNS disproves this claim"* and *"our resolver was briefly unhappy"* can be told apart. One is
an impersonator; the other is Googlebot during a blip. See
[verification](../detection/verification.md).

## The evasion ladder

Five cases that run from crude to undetectable, and **the top rungs are expected to fail**:

| | | |
|-|-|-|
| 1 | Copied the User-Agent only | caught, four independent signals |
| 2 | Copied the header set, not the order | caught, weakly |
| 3 | Copied the order and the Client Hints | **not caught** from one request |
| 4 | …at a machine-perfect rhythm | caught by `cadence`, and only by `cadence` |
| 5 | …paced like a person, a few pages per address | **not caught at all** |

Level 5 is in the corpus so that nobody can claim otherwise. At that point the difference
from a person has stopped being technical, and what defeats it is cost — a
[proof of work](../challenge/index.md), or an account — not detection. See
[the threat model](../concepts/threat-model.md).

## Running it against your own configuration

It is a published entry point, not a test fixture:

```ts
import { runCorpus } from "@osqd/bothandlerjs/corpus";

const scorecard = await runCorpus({
  create: ({ resolver, clock }) => new BotHandler({ ...myProductionConfig, resolver, clock }),
  assertActions: false,   // your actions are yours; the invariants are not
});

if (scorecard.falsePositives.length > 0) throw new Error("this policy turns people away");
```

`assertActions: false` is the setting to understand. The corpus knows what each case *is*;
it does not know what your policy should do about it. The invariants — nothing marked as a
person is denied — hold regardless.

DNS is controlled and the clock is manual, so it runs offline, deterministically, in CI.

## Adding cases

See [`src/corpus/README.md`](../../src/corpus/README.md). The bar is provenance: a case has
to say where its headers came from, and a test enforces it. A corpus of invented traffic
would make every claim in this documentation false in a way nobody could see.

## Related

- [The CLI](cli.md#check) — the same corpus, one command
- [Log replay](replay.md) — the complement: traffic that is actually yours
- [The guard](../concepts/the-guard.md) — the invariant this enforces
- [Presets](../policy/presets.md) — the four the scorecard reports on
