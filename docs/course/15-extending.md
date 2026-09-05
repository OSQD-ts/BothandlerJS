# Lesson 15 — Extending it

**Goal:** add a detector, a signature, an action and a browser signal of your own — and
meet the certainty rule from the other side.

← [Course](index.md) · Prev: [Scaling](14-scaling.md) · Next: [Proving it](16-proving-it.md)

---

## A detector of your own

A detector returns **evidence**, never a verdict. It has no idea what the policy will do
with what it finds, and that separation is what keeps the certainty model intact.

Serif's checkout is being hammered. Nothing shipped knows what a checkout is:

```js
function checkoutVelocity() {
  return {
    id: "checkout-velocity",
    description: "More checkout attempts in a minute than a person makes",
    cost: "cheap",
    stage: "always",
    inspect(ctx) {
      if (!ctx.facts.path.startsWith("/checkout")) return undefined;

      const attempts = ctx.state.requestsWithin(60_000, ctx.facts.timestamp);
      if (attempts < 5) return undefined;

      return {
        detector: "checkout-velocity",
        summary: `${attempts} checkout attempts in a minute`,
        direction: "bot",
        certainty: "strong",     // not `certain` — a shared address explains it too
        botClass: "automation",
      };
    },
  };
}

const detector = new BotHandler({ extraDetectors: [checkoutVelocity()] });
```

### Checkpoint

Six POSTs to `/checkout` from one address, 800 ms apart:

```
checkout burst: score=66 verdict=suspected-bot
  [strong] checkout-velocity: 6 checkout attempts in a minute
  [weak] accept-signature: Accept-Language is a single bare tag ("en-GB") with no fallback chain
```

## The certainty rule, from the inside

Look again at that comment: `certainty: "strong"`, not `certain`.

Six checkout attempts in a minute is a *strong* signal and it is not proof. An office
behind one NAT address, a family sharing a connection, a customer whose payment kept
failing — all produce it. To mark it `certain` you would have to write a
`deterministicBasis` sentence explaining why no benign explanation exists, and you cannot,
because one does.

**That is the forcing function.** If you cannot write the sentence, your evidence is
`strong`. Outside production the library *enforces* it: `certain` evidence with no basis is
rejected. Inside production it downgrades to a warning instead, so a third-party detector
with a missing basis cannot take a live site down.

```js
return {
  detector: "checkout-velocity",
  certainty: "certain",
  deterministicBasis: "…",     // you would have to justify it here, in writing
  // …
};
```

Try it without the basis and watch it get refused. That refusal is the library defending the
one guarantee it makes.

## Cost and stage, honestly

Mark a detector `cost: "io"` if it touches the network or a shared store, and it runs
concurrently under a timeout. Mislabelling one would put an unbounded await on the request
path — so the engine times out any promise a `cheap` detector returns anyway.

Use `stage: "confirming"` when your work is only worth doing if something else already found
an identity to confirm.

## Replacing a shipped detector

`detectors` replaces the whole set, so map over the default list:

```js
import { defaultDetectors, probeSignatureDetector } from "@osqd/bothandlerjs";

new BotHandler({
  detectors: defaultDetectors().map((d) =>
    d.id === "probe-signature" ? probeSignatureDetector({ ignore: ["/wp-login.php"] }) : d,
  ),
});
```

## A signature of your own

Serif's partner sends a nightly sync. You want it recognised and allowed by name:

```js
const partner = {
  id: "serif-partner-sync",
  name: "Serif Partner Sync",
  tokens: ["serifpartnersync"],     // lowercase — see below
  category: "library",
  benign: true,
  verification: { kind: "none" },
};

const detector = new BotHandler({
  extraSignatures: [partner],
  rules: [{ id: "partner-allow", match: { identity: "serif-partner-sync" }, action: "allow",
            reason: "Our own partner integration." }],
});
```

### Checkpoint

```
verdict=confirmed-bot class=http-client identity=serif-partner-sync certain=true
  [certain] self-identified: User-Agent identifies Serif Partner Sync
decision: allow via rule "partner-allow"
```

**`tokens` must be lowercase.** Matching lowercases the User-Agent first, so an uppercase
token silently never matches — no error, no warning, just a signature that does nothing. It
is the single easiest mistake to make here, and it costs an afternoon.

`verification` is required. Use `{ kind: "none" }` for a client with no verifiable identity,
`{ kind: "fcrdns", domains: [...] }` where the operator publishes reverse DNS, or
`{ kind: "ip-ranges" }` where they publish addresses.

Set `conclusive: false` with a `caveat` when a token can legitimately appear on a request a
person made. Electron is the motivating case: that User-Agent comes from VS Code's browser,
Slack, Discord and Postman — real Chromium instances with a human driving them.

## An action of your own

```js
import { defineHandler } from "@osqd/bothandlerjs";

const emptyResults = defineHandler({
  id: "empty-results",
  description: "Serves an empty result set rather than an error",
  execute: ({ assessment }) => ({
    kind: "respond",
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ results: [] }),
  }),
});

new BotHandler({
  handlers: [emptyResults],
  rules: [{ id: "shadow", match: { botClass: "scraper" }, action: "custom",
            params: { handler: "empty-results" } }],
});
```

Return `{ kind: "continue" }` — optionally with `requestHeaders`, `responseHeaders` or
`delayMs` — or `{ kind: "respond", status, headers, body }`, or `{ kind: "drop" }`. It may
be async.

**Remember the guard does not apply here.** It cannot know what your handler does. A handler
that denies service is a decision you own entirely — which is fine, as long as you know you
are making it.

A handler named in a rule but not registered serves the request and warns.

## Browser signals

An optional page script reports what only the browser can see — `navigator.webdriver`,
automation properties, timing:

```js
import { renderClientScript } from "@osqd/bothandlerjs/client";

// `endpoint` is required: it is your route, and it should be cheap and rate-limited.
app.get("/", (req, res) =>
  res.send(`<body>…${renderClientScript({ endpoint: "/__signals", nonce: res.locals.nonce })}</body>`),
);
```

It posts back to that endpoint, and the `client-signals` detector reads what arrives. Supply
the `nonce` if your Content-Security-Policy needs one.

**It is capped at `moderate`, permanently, whatever it reports.** The browser is the one
place an adversary has complete control: `navigator.webdriver` proves what the client *chose
to report*, and a scraper that wants to lie about it has already won that argument. Treating
it as conclusive would move the whole guarantee inside the attacker's process.

So it is real evidence, weighted honestly, and it can never on its own deny anybody.

## Exercise

Serif wants to catch scripted gift-card redemption: many distinct codes tried from one
actor, few succeeding. Write the detector, and decide its tier.

<details>
<summary>Answer</summary>

```js
function giftCardProbing(redemptions) {
  return {
    id: "gift-card-probing",
    description: "Many distinct gift-card codes tried from one actor",
    cost: "cheap",
    stage: "always",
    inspect(ctx) {
      if (ctx.facts.path !== "/gift-cards/redeem") return undefined;
      const tried = redemptions.recentFailures(ctx.actorKey, 10 * 60_000);
      if (tried < 12) return undefined;
      return {
        detector: "gift-card-probing",
        summary: `${tried} failed gift-card redemptions in ten minutes`,
        direction: "bot",
        certainty: "strong",
        botClass: "automation",
      };
    },
  };
}
```

**`strong`, not `certain`.** Twelve failed redemptions is a strong signal about a *shared
address* as much as about a script — a busy office at Christmas produces it. You cannot
write the basis sentence, so it is not certain.

**`cheap`, only if `redemptions` is in memory.** If it queries a database, it is `io` — and
mislabelling it would put a database round trip on the request path of every checkout.

And note that a `strong` signal is enough to challenge or rate-limit, which is the right
response to card probing anyway. You lose nothing by being honest about the tier.
</details>

## What you learned

- A detector returns evidence, never a verdict
- The `deterministicBasis` requirement is a forcing function: if you cannot write it, it is
  `strong`
- `cost` must be honest, or you put an await on the request path
- Signature `tokens` must be lowercase, and the failure is silent
- Custom handlers sit outside the guard, deliberately
- Browser signals are capped at `moderate` for ever, because that is the attacker's process

## Reference

- [Writing a detector](../detection/writing-a-detector.md) · [Signatures](../detection/signatures.md)
- [Browser signals](../detection/client-signals.md) · [Actions](../policy/actions.md)

Next: [Proving it, and the capstone](16-proving-it.md).
