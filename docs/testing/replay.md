# Log replay

What your policy would have done to yesterday.

← [Documentation](../index.md) · [Testing](index.md)

---

A bot policy is a claim about *your* traffic. The only honest way to check it before it
starts turning people away is to run it over traffic you already have.

```bash
npx bothandlerjs replay /var/log/nginx/access.log --preset protect-content
```

```
  replay — 4,000 requests, preset "protect-content", format clf

  verdicts
    unknown            2906   72.7%  ██████████████████
    confirmed-bot      1094   27.4%  ███████

  what would have happened
    allow           2906   72.7%  ██████████████████
    challenge        477   11.9%  ███
    tag              387    9.7%  ██
    block            116    2.9%  █

  116 request(s) would have been DENIED, in 1 distinct kind(s). Read them.
  ─────────────────────────────────────────────────────────────────────
     116x  block by rule "scanner-block" — confirmed-bot, proven
          sqlmap/1.7.2#stable (https://sqlmap.org)
          [certain] self-identified: User-Agent identifies sqlmap
```

**That last block is the point of the exercise.** Every request the policy would have
refused, grouped by kind, with the evidence. If any of them is a person, the policy is
wrong — and you found out from a log file rather than from a support ticket.

---

## Prefer JSON Lines, and here is why

It accepts Combined/Common Log Format or JSON Lines. **JSON Lines is much better**, and the
reason is a real distinction the library models:

> A header missing from a *record* is not a header missing from the *request*.

An nginx access line records the User-Agent and the Referer and nothing else. Several
[detectors](../detection/detectors.md) reason from absence — "claims to be a browser but
sent no `Accept-Language`" — and on a CLF line that reasoning is not merely weak, it is
meaningless.

So `RequestFacts.partialHeaders` marks a header-poor source, and every absence-based
detector stands down; the ones that reason from what *is* present carry on. Without it, a
replay over real nginx logs reports most of a site's human traffic as suspected bots —
worse than useless, because it is confidently wrong.

A CLF replay therefore **under-reports**, and its silence is not a clean bill of health.

### The JSON Lines shape

One object per line:

```json
{ "ip": "203.0.113.5", "method": "GET", "url": "/products/12", "headers": { "user-agent": "...", "accept-language": "en-GB" }, "timestamp": 1757030400000 }
```

Configure your access log to emit the header set you care about — at minimum `user-agent`,
`accept`, `accept-language`, `accept-encoding`, `referer` and the `sec-ch-ua`/`sec-fetch-*`
groups — and the replay sees what detection would have seen.

## Setting `partialHeaders` yourself

Whenever you build facts from something that filters headers:

```ts
createFacts({ method, url, headers, ip, partialHeaders: true });
```

Any log pipeline, any CDN export, any sampled trace. It is the difference between a replay
that tells you something and a replay that tells you everything is a bot.

## What it cannot tell you

**Behaviour it did not record.** `cadence` and `crawl-breadth` read a sequence, so they work
only if your log preserves ordering and timestamps — which JSON Lines does and a truncated
sample does not.

**DNS as it was.** [Verification](../detection/verification.md) runs against today's DNS,
not the DNS of the day the log was written. A crawler that has since changed hands verifies
differently.

**The effect of the mitigation.** A replay shows what the policy would have *asked for*, not
how the traffic would have responded to being challenged or slowed. Those are the same
number only if nobody adapts, and adapting is what the population in question does.

## Related

- [The CLI](cli.md) — every flag
- [The corpus](corpus.md) — the complement: traffic you do not have yet
- [Detection](../detection/index.md) — the pipeline being replayed
