# Lesson 2 — Proof and suspicion

**Goal:** understand the distinction the entire library is built on, and why every other
design decision follows from it.

← [Course](index.md) · Prev: [First assessment](01-first-assessment.md) · Next: [Verdicts and scores](03-verdicts-and-scores.md)

---

## The problem every bot detector has

Every signal that catches sophisticated automation is *probabilistic*: header
consistency, timing regularity, missing cookies, TLS fingerprints. And every one of them
has a population of real people who trip it.

Someone on a privacy-hardened browser. Someone behind a corporate proxy that strips
headers. Someone using a screen reader. Someone on a hotel network, or a five-year-old
phone, or a carrier that transcodes pages.

The usual answer is to add the signals into a score and block above a threshold. **That is
the mistake this library exists to avoid.** Points do not compose into proof. Two unrelated
suspicions about an unusual but entirely real browser reach 100 as readily as two
well-founded ones — and the people who get caught are disproportionately the ones with the
strongest reasons for their unusual setup.

So evidence here lives in two compartments that never mix.

| | Deterministic (`certain`) | Probabilistic (`strong` / `moderate` / `weak`) |
| --- | --- | --- |
| Rests on | a declaration, a contradiction, a trap, an external authority | a pattern automation usually shows |
| Can it be wrong? | only if the client lied about itself | yes, about real people |
| How it combines | short-circuits to a verdict | noisy-OR into a score of 0–99 |
| Can it deny service? | **yes** | **no** |
| What it can still do | anything | tag, log, delay, rate-limit, challenge, alert |

## See it

Print the basis of the curl evidence from lesson 1:

```js
const assessment = await detector.assess(
  createFacts({ method: "GET", url: "/", headers: { host: "serif.example", "user-agent": "curl/8.4.0" }, ip: "203.0.113.10" }),
);
console.log(assessment.evidence[0].deterministicBasis);
```

### Checkpoint

```
The product token "curl/" is emitted by an HTTP library or an automation runtime and by
no browser. Nothing a person does in a browser produces it.
```

**Every piece of `certain` evidence has to carry one of those sentences**, in writing, and
the library refuses evidence that claims certainty without one. It is a forcing function:
if you cannot write the sentence, your evidence is `strong`. When you write your own
detector in [lesson 15](15-extending.md) you will meet this rule from the other side.

## The five things that earn `certain`

1. **Self-declaration.** The client says it is a bot: `curl/8.4.0`, `python-requests`,
   `Googlebot/2.1`, `HeadlessChrome` in a Client Hints brand list. Not an inference — you
   are believing the client's own statement about itself, and no honest client is ever
   harmed by being believed. If the statement is a lie, the misclassification is the
   client's doing.
2. **A refuted third-party identity.** It claimed to be Googlebot and DNS says otherwise.
   Note how narrow that is: a privacy extension rewriting a User-Agent to a *generic*
   browser string never lands here, because it never claims to be a named, verifiable
   third party.
3. **A confirmed third-party identity.** The same check passing. Used to *allow*.
4. **A trap.** A link hidden from layout and from assistive technology and excluded in
   `robots.txt`. Detection by construction rather than by inference — no sequence of user
   input reaches it. [Lesson 8](08-traps.md).
5. **A protocol violation.** Three of them, each a rule a recipient is *required* to
   enforce: a connection-specific header on HTTP/2 ([RFC 9113 §8.2.2](https://www.rfc-editor.org/rfc/rfc9113#section-8.2.2)),
   `Content-Length` beside `Transfer-Encoding` ([RFC 9112 §6.1](https://www.rfc-editor.org/rfc/rfc9112#section-6.1)),
   and a repeated `Host` ([RFC 9112 §3.2](https://www.rfc-editor.org/rfc/rfc9112#section-3.2)).

Plus one on the human side: **your own application's assertion** that a request belongs to
a person.

## The rule that catches people out

> **No argument from absence may ever be `certain`.**

A header missing from your *facts* is not a header missing from the *request*. An HTTP/1.1
request with no `Host` violates RFC 9112 as plainly as anything above — and it is
deliberately not proven here, because somebody building facts from a log line, a WAF event
or a partial adapter would otherwise manufacture proof against every request in the file.

You will rely on this in [lesson 16](16-proving-it.md) when you replay your own access
logs, where most headers genuinely are missing from the record.

## How suspicion adds up

Probabilistic evidence combines by **noisy-OR** — `1 − Π(1 − wᵢ)` — not by a sum. The
weights are `strong` 0.60, `moderate` 0.35, `weak` 0.15.

It is bounded without clamping, and it has the right shape: many weak signals do add up,
but asymptotically. **The probabilistic score is capped at 99**, because 100 means proof.

Human evidence subtracts: `score = pBot × (1 − pHuman)`.

## One cause, counted once

Noisy-OR is only sound over *independent* signals, and several of these are not. A
corporate proxy that strips `Sec-Fetch-*` also strips the Client Hints and the
`Accept-Language` — so three detectors fire at once about one person behind one appliance,
and the arithmetic reads their agreement as corroboration when it is an echo.

Evidence may therefore declare a **`family`**: a shared root cause. Within a family the
engine takes the strongest observation instead of compounding.

You saw this in lesson 1's exercise without noticing. Print the families:

```js
for (const piece of assessment.evidence) {
  console.log(piece.certainty.padEnd(9), (piece.family ?? "—").padEnd(18), piece.summary);
}
```

Run it against the copied-User-Agent request. The two `header-integrity` observations share
a family, so they count once. That scraper scores 45 rather than the ~60 it would reach if
its two absences were treated as independent — and the reason is that a real corporate
network produces exactly the same pair, every day.

Families are a scoring correction and nothing more. **They never touch the proven path.**

## Exercise

Build a request that is proven a bot *and* carries a lot of suspicion, and one that carries
suspicion alone. Compare `certain`, `score` and `confidence` on each.

Then answer, without running anything: a client scores 97 from six independent
probabilistic signals. Under the default configuration, can a rule block it?

<details>
<summary>Answer</summary>

**No.** Not at 97, not at 99. The score is not what gates a terminal action — `certain` is.
Six probabilistic signals are six things a real person can trip, and the population that
trips six of them is disproportionately the population with the strongest reasons for an
unusual setup.

That is [lesson 4](04-the-guard.md), and it is enforced by a mechanism you cannot forget to
apply.
</details>

## What you learned

- Probabilistic signals all have real people who trip them; that is why points never become
  proof
- Exactly five things earn `certain`, and each must carry a written basis
- No argument from absence may ever be certain
- Noisy-OR bounds suspicion at 99; human evidence subtracts
- One root cause is counted once, so a stripped-header proxy is not three reasons

## Reference

- [Evidence and certainty](../concepts/evidence.md) — the full model
- [Design decisions](../design/decisions.md) — this choice, and what it costs
- [Threat model](../concepts/threat-model.md) — who this catches and who it does not

Next: [Verdicts, classes and scores](03-verdicts-and-scores.md).
