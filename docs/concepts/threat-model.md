# Threat model

What this library stops, what it raises the cost of, and what it cannot touch.

← [Documentation](../index.md)

---

Most bot tooling is vague about this, which is how people end up trusting it for things it
cannot do. This page is the honest version, and every claim on it is
[measured](../testing/corpus.md) rather than asserted.

---

## The populations

| Who | What they send | What happens |
| --- | -------------- | ------------ |
| **Honest automation** | `curl/8.4.0`, `python-requests`, `Googlebot` | proven by [self-declaration](evidence.md); you decide by policy |
| **Verifiable crawlers** | a named identity backed by DNS or published ranges | [proven either way](../detection/verification.md) — confirmed or refuted |
| **Careless scrapers** | a copied User-Agent and nothing else | caught by four independent signals |
| **Competent scrapers** | a copied header set, in the right order, with Client Hints | not caught from one request; caught by [behaviour](../detection/detectors.md) if they are quick |
| **Patient adversaries** | real Chrome, residential proxies, human pace | **not caught, and this library says so** |
| **Scanners** | `/.env`, `/.git/config`, JNDI, `TRACE` | [`probe-signature`](../detection/detectors.md), one request at a time |
| **People who look odd** | Tor, corporate proxies, screen readers, old phones | suspected, never denied — this is what [the guard](the-guard.md) is for |

The last two rows are the same problem seen from both ends, and the reason the whole design
is organised around proof rather than points.

## The evasion ladder

Five cases in the corpus, running from crude to undetectable. **The top rungs are expected
to fail**, and they are kept so that nobody can claim otherwise:

| | | |
|-|-|-|
| 1 | Copied the User-Agent only | caught, four independent signals |
| 2 | Copied the header set, not the order | caught, weakly |
| 3 | Copied the order and the Client Hints | **not caught** from one request |
| 4 | …at a machine-perfect rhythm | caught by `cadence`, and only by `cadence` |
| 5 | …paced like a person, a few pages per address | **not caught at all** |

At level 5 the difference from a person has stopped being technical. What defeats it is
**cost** — a [proof of work](../challenge/index.md), or an account — not detection.

---

## What this library cannot do

**Stop a determined, well-resourced adversary.** Someone running real Chrome through a
residential proxy pool, at human pace, with correct headers, solving the proof of work, is
indistinguishable from a person at the HTTP layer. What this raises is the *cost*.

**Prove somebody is human.** No signal here does that and none claims to. Proof of work
proves CPU. `navigator.webdriver` proves what the client chose to report. The only
conclusive human signal is [your own application's assertion](../reference/configuration.md).

**Replace authentication, authorisation or a WAF.** It classifies traffic. It is not a
security boundary and nothing about it should be load-bearing for access control. This is
the most important sentence on the page.

**Stop a DDoS.** It runs inside your process, after the connection is accepted. Volume that
hurts you at the network layer needs handling at the network layer.

**Ship IP intelligence.** Address-to-operator mappings go stale within weeks, and a stale
mapping is a false positive with a long half-life. Bring your own, from a source you refresh
and can audit.

**Be right about a shared address.** Behind CGNAT, "one [actor](actors.md)" is thousands of
people — which is exactly why the behavioural signals are capped where they are.

**Escalate on a wordlist walk.** `probe-signature` reads one request at a time, so a scanner
working through five hundred paths produces five hundred separate observations rather than a
mounting case. That is the price of a detector that runs unchanged over a log file;
enumeration over time is what `rate-anomaly`, `cadence` and `crawl-breadth` are for.

---

## The adversary's view of the library itself

Worth thinking about, because a detector that explains itself to the client is a detector
being tuned against.

**Verdict headers are off by default.** An `X-Bot-Score` in the response is a live feedback
signal: change one header, watch the number fall, iterate. Request-side tagging tells your
application the same thing and the client nothing.

**Metrics and the dashboard describe your detection.** The detector-firing series is exactly
what somebody tuning a scraper would like to read. Serve them where only you can reach them,
and use [the dashboard's redaction and sections](../operations/dashboard.md) when more people
need to watch than need to know.

**The challenge is public by design.** Its difficulty and its mechanism are visible to
everyone. That is fine — it is a cost, not a secret, and a cost that only works while hidden
is not a cost.

**Traps are the one thing to keep quiet about.** A trap works because no person can reach
it. Publishing the path in a public repository, a `robots.txt` `Allow` line, or a client-side
comment turns proof back into a guess.

---

## What it is genuinely good at

Being clear about the limits above is what makes this list credible:

- **Identifying honest automation exactly**, so you can decide about it by policy rather
  than by suspicion — including the [AI crawlers, split by job](../policy/presets.md#decline-ai-training).
- **Refuting forged identities**, with proof rather than inference.
- **Making bulk extraction expensive** without touching anybody who is not doing it.
- **Never denying a person on a guess** — enforced by [the guard](the-guard.md), checked by
  [the corpus](../testing/corpus.md), and visible as `bothandler_downgrades_total`.
- **Telling you what your policy would do**, [before it does it](../testing/index.md).

## Related

- [Evidence](evidence.md) — proof versus suspicion, in detail
- [The guard](the-guard.md) — the mechanism the last claim rests on
- [The corpus](../testing/corpus.md) — where the ladder above lives
- [Detectors](../detection/detectors.md) — what each signal is actually worth
