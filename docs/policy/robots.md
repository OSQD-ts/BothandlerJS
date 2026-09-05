# robots.txt

Saying out loud what your policy already does.

← [Documentation](../index.md) · [Policy](index.md)

---

## Why this is here

Declining a crawler and not saying so is the worst of both worlds: it keeps coming, wastes
your bandwidth rediscovering that it is unwelcome on every request, and you get no credit
for having a policy. `robots.txt` is where you say it — and for the well-behaved crawlers,
saying it is the *only* thing you need to do, because they will simply stop.

Two things this will not pretend. `robots.txt` is a request, not enforcement; everything
that ignores it is exactly the population this library exists for. And a generated file can
only reflect rules it can **read**.

References: [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) is the standard;
[robotstxt.org](https://www.robotstxt.org/) is the older convention it formalises.

---

## From your policy

The useful entry point. It reads your rules and writes the file that matches them:

```ts
import { declineAiTraining, robotsFromRules } from "@osqd/bothandlerjs";

const { robotsTxt, declined, served, unreadable } = robotsFromRules(declineAiTraining(), {
  disallowPaths: ["/internal/", "/admin-console"],   // your trap paths belong here
  sitemap: "https://example.com/sitemap.xml",
});

app.get("/robots.txt", (_req, res) => res.type("text/plain").send(robotsTxt));
```

It reads every rule whose action [denies service](actions.md) and whose `match` names an
`identity` or a `category`, and declines exactly those crawlers.

### The three fields you must look at

**`declined`** — the signature ids in the file, with categories expanded to the crawlers
they cover. Reporting only the explicitly-named ids would say "0 declined" for a policy
that turns away an entire category.

**`served`** — crawlers a later rule would have declined, but an earlier rule serves.
Policies are first-match-wins, so these are correctly *absent* from the file.
`decline-ai-training` is the case that found this: it serves `ChatGPT-User` and blocks the
rest of the `ai` category, and the generated file was telling `ChatGPT-User` to go away.
"Why is GPTBot in my robots.txt but ChatGPT-User is not" has an answer, and it is your own
rule order.

**`unreadable`** — rules that could not be read, with the reason. Two kinds:

- *the match is a predicate function* — it can be run, but not asked which crawlers it is
  about.
- *the match is scoped to a path* — the rule denies service **there**, but a named group in
  `robots.txt` gets `Disallow: /`, the whole site. Reported rather than passed over,
  because the error runs in the expensive direction: a crawler told to stay away entirely
  stops fetching the pages you wanted indexed, and that surfaces weeks later as a ranking
  drop with nothing in the logs pointing at this file.

Check `unreadable` before publishing and add anything it names by hand. A `robots.txt` that
silently omits something you block is worse than no generated file at all — it tells
crawlers they are welcome where they are not.

---

## By hand

When you want a file that is not derived from a policy:

```ts
import { generateRobotsTxt } from "@osqd/bothandlerjs";

generateRobotsTxt({
  header: ["# Automated collection is declined. Contact abuse@example.com."],
  disallowCategories: ["ai"],
  disallowBots: ["semrushbot", "ahrefsbot"],
  disallowPaths: ["/internal/", "/cart"],
  allowPaths: ["/blog/"],
  crawlDelay: 5,
  sitemap: ["https://example.com/sitemap.xml"],
});
```

| Option | Effect |
| ------ | ------ |
| `disallowBots` | signature ids to decline entirely |
| `disallowCategories` | whole [categories](../detection/signatures.md) — `ai`, `seo`, … |
| `disallowPaths` | disallowed for every crawler; put your [trap](../detection/detectors.md) paths here |
| `allowPaths` | rendered ahead of the disallows |
| `sitemap` | absolute URLs, per the specification |
| `crawlDelay` | seconds, wildcard group only; not honoured by every crawler |
| `header` | verbatim lines at the top, already comment-prefixed |
| `signatures` | the signature database to resolve ids against |

### The grouping rule this gets right for you

Under RFC 9309 a crawler obeys the most specific group that names it and **ignores every
other group**. So a named `User-agent: GPTBot` group replaces the wildcard group outright
for GPTBot — including your `Disallow: /internal/` lines.

The renderer repeats global path rules inside every named group. Forgetting that is the
classic way a `robots.txt` accidentally *un*-blocks a trap path for exactly the crawlers
you were most careful about.

The wildcard group is emitted first purely as a courtesy to the person reading the file;
crawlers pick their group by specificity, not by position.

---

## From the command line

```bash
npx @osqd/bothandlerjs robots --preset decline-ai-training --sitemap https://example.com/sitemap.xml
```

See [the CLI](../testing/cli.md).

## Related

- [Presets](presets.md) — `decline-ai-training`, which this pairs with
- [Signatures](../detection/signatures.md) — the ids and categories being named
- [Detectors](../detection/detectors.md) — the trap paths worth disallowing here
