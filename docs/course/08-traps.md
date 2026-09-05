# Lesson 8 — Traps

**Goal:** lay a honeypot properly — including the POST-body case that silently does
nothing if you skip it.

← [Course](index.md) · Prev: [Actors and behaviour](07-actors.md) · Next: [Rules](09-rules.md)

---

## Why a trap is proof

Every other probabilistic detector asks *"does this look like automation?"*. A trap asks
*"did you fetch a thing that no person can reach?"* — and that is detection by
**construction** rather than by inference.

A trap link is positioned off-screen, marked `aria-hidden` and `tabindex="-1"` so assistive
technology skips it, `rel="nofollow noindex"`, and disallowed in `robots.txt`. There is no
sequence of user input that reaches it. A client that fetched it either ignored every one
of those signals or never rendered the page at all.

That is why `trap` is one of the five things that earn `certain`, and it is the cheapest
proof in the library — no statistics, no DNS, no history.

## Do this

```js
import { BotHandler, createFacts, renderTrapLink, DEFAULT_TRAP_PATHS } from "@osqd/bothandlerjs";

console.log(DEFAULT_TRAP_PATHS);
console.log(renderTrapLink("/internal/export.csv"));

const detector = new BotHandler();
const caught = await detector.assess(
  createFacts({
    method: "GET",
    url: "/internal/export.csv",
    ip: "203.0.113.150",
    headers: { host: "serif.example", "user-agent": CHROME["user-agent"], accept: "text/html" },
  }),
);
console.log(`verdict=${caught.verdict} certain=${caught.certain} score=${caught.score}`);
for (const e of caught.evidence) console.log(`  [${e.certainty}] ${e.detector}: ${e.summary}`);
console.log("basis:", caught.evidence[0].deterministicBasis);
```

Notice the request carries a **complete, believable Chrome header set**. It is still
proven, because the trap does not care what you claim to be — only where you went.

## Putting one in a page

```js
app.get("/", (req, res) => {
  res.send(`
    <main>…your page…</main>
    ${renderTrapLink("/internal/export.csv", { label: "Archive index" })}
  `);
});
```

And tell the well-behaved crawlers to stay away, so that only the ones ignoring
`robots.txt` are ever caught:

```js
import { trapRobotsEntries } from "@osqd/bothandlerjs";
console.log(trapRobotsEntries());
// User-agent: *
// Disallow: /internal/export.csv
// Disallow: /api/v1/all-users
// Disallow: /sitemap-index-full.xml
```

This is not a courtesy. **Publishing the disallow is what makes the trap proof.** Without
it, Googlebot follows the link — it has no way to know it should not — and you have proven
something false about a crawler you wanted.

## The form-field trap, and the mistake everyone makes

`renderTrapField` gives you a hidden input to drop into a form:

```js
import { renderTrapField } from "@osqd/bothandlerjs";
res.send(`<form method="post" action="/signup">${renderTrapField("company_url")}…</form>`);
```

A bot filling every input it finds fills this one. A person never sees it.

**But the engine reads no request body.** Doing so would consume the stream before your own
parser saw it. So a hidden field on a `method="post"` form arrives somewhere this library
cannot see — and the forms worth protecting are POSTs.

Skip the next step and the field is rendered, filled by a bot, and **silently ignored**:

```js
import { BotHandler, TRAP_FIELD_SOURCE, defaultDetectors, trapDetector } from "@osqd/bothandlerjs";
import { botHandler } from "@osqd/bothandlerjs/adapters";

const detector = new BotHandler({
  // Register the field name — the detector cannot recognise a honeypot it was never told about.
  detectors: defaultDetectors().map((d) =>
    d.id === "trap" ? trapDetector({ formFields: ["company_url"] }) : d,
  ),
});

app.use(express.urlencoded({ extended: false }));   // your parser runs first
app.use(
  botHandler(detector, {
    enrich: (request, facts) => ({ ...facts, extra: { [TRAP_FIELD_SOURCE]: request.body } }),
  }),
);
```

Two things have to line up: the detector must be **told the field name**, and the parsed
body must be **handed over** with `enrich`. A field arriving in the query string is read
without any of this.

## Choosing paths

The defaults are `/internal/export.csv`, `/api/v1/all-users` and
`/sitemap-index-full.xml` — chosen to look like something worth fetching. Replace them with
paths that fit your site:

```js
trapDetector({ paths: ["/admin/backup.sql", "/customers/export"] })
```

Two rules:

**Do not use a path you might one day build.** A trap that becomes a real endpoint proves
things about your own users.

**Keep them out of public view.** A trap works because no person can reach it — publishing
the path in a public repository or a client-side comment turns proof back into a guess.
This is the one part of your configuration worth treating as a secret.

## Exercise

Serif has a signup form being hit by a registration bot. Lay a trap that catches it, and
list everything that has to be true for it to work.

<details>
<summary>Answer</summary>

```js
// 1. Tell the detector the field name.
const detector = new BotHandler({
  detectors: defaultDetectors().map((d) =>
    d.id === "trap" ? trapDetector({ formFields: ["serif_referral_code"] }) : d,
  ),
  rules: [{ id: "trap-block", match: { detector: "trap", certain: true }, action: "block" }],
});

// 2. Render it in the form.
`<form method="post" action="/signup">${renderTrapField("serif_referral_code")}…</form>`

// 3. Parse the body first, then hand it over.
app.use(express.urlencoded({ extended: false }));
app.use(botHandler(detector, {
  enrich: (request, facts) => ({ ...facts, extra: { [TRAP_FIELD_SOURCE]: request.body } }),
}));
```

Four things must all hold: the field is **rendered**, its name is **registered** with the
detector, your parser runs **before** the middleware, and `enrich` **hands the body over**.
Miss any one and the trap fails open silently — no error, no warning, just a honeypot that
never catches anything.

That silence is why this lesson exists.
</details>

## What you learned

- A trap is proof by construction, and needs no statistics at all
- Publishing the disallow in `robots.txt` is what makes it proof rather than a mistake
- A POST field trap needs the name registered *and* the body handed over with `enrich`
- Trap paths are the one part of your config to keep quiet about

## Reference

- [The detectors](../detection/detectors.md) — `trap` in full
- [Adapters](../integration/adapters.md) — `enrich`
- [robots.txt](../policy/robots.md)

Next: [Rules](09-rules.md) — writing the policy.
