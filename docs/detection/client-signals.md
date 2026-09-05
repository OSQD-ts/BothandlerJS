# Browser signals

An optional page script, and the hard ceiling on anything it reports.

← [Documentation](../index.md) · [The detectors](detectors.md)

---

Everything else in this library reads what arrived over the wire. This reads what the
browser says about itself — which is more informative and much less trustworthy, and the
design is mostly about holding those two facts together.

## What it reports

```ts
interface ClientSignals {
  webdriver?: boolean;            // navigator.webdriver === true
  noLanguages?: boolean;          // navigator.languages is empty
  zeroDimensions?: boolean;       // screen.width === 0
  inconsistentPlatform?: boolean; // userAgentData.platform disagrees with the UA string
  interacted?: boolean;           // a trusted pointer/key event happened
  msToInteraction?: number;
  automationGlobals?: string[];   // _phantom, __nightmare, __selenium_unwrapped, …
}
```

That is the whole list, and the omissions are the point. No canvas hash, no WebGL
renderer, no font enumeration, no audio fingerprint. Those would raise accuracy and would
make this a fingerprinting library, which is a different product with different ethics —
see [design decisions](../design/decisions.md).

## Wiring it up

Three pieces: render the script, receive the report, attach it to the request.

```ts
import { renderClientScript, parseClientSignals } from "bothandlerjs";

// 1. On any page you want signals from. The nonce matches your CSP.
app.get("/", (req, res) =>
  res.send(page + renderClientScript({ endpoint: "/__signals", nonce: res.locals.nonce })),
);

// 2. An endpoint that stores what it receives against the session.
app.post("/__signals", express.json({ limit: "2kb" }), (req, res) => {
  const signals = parseClientSignals(req.body);
  if (signals) req.session.botSignals = signals;
  res.status(204).end();
});

// 3. Attach it, so the detector can read it.
app.use(
  botHandler(detector, {
    enrich: (request, facts) => ({ ...facts, extra: { clientSignals: request.session?.botSignals } }),
  }),
);
```

**Where the report lives between step 2 and step 3 is your decision, not the library's.**
A session store, a short-lived cache keyed by a cookie, an edge KV — the library does not
invent a storage mechanism, because where per-session data lives is a question only your
application can answer.

The script reports on `sendBeacon` (falling back to `fetch` with `keepalive`), so a short
visit still reports as the page goes away, and it reports again after the first trusted
interaction if one happens within `interactionWindowMs`.

## Why it is capped at `moderate`

Permanently, and no option changes it.

Every value here was produced by JavaScript running inside the client, which is the one
place an adversary has complete control. A framework that wants `navigator.webdriver` to
read `false` sets it to `false`, and everything the detector sees afterwards is whatever
that framework decided to say.

What this genuinely catches is **automation that never bothered to hide** — Selenium out
of the box, a scripted Chrome somebody pointed at your site this afternoon — which is a
large share of real bot traffic and worth catching. What it must never do is convince you
that a clean report means a person.

`isTrusted` on the interaction event is the most informative bit on the page, and it is
still forgeable by a framework driving a real browser. Treat it as evidence that somebody
*probably* touched the page, not as proof that anybody did.

## What the absence of a report means

Nothing. A visitor with JavaScript disabled, a request that never reached an HTML page, a
beacon that was blocked — all produce no signals, and the detector stays silent rather
than treating silence as suspicion. A great many real people browse this way.

## Related

- [The detectors](detectors.md#client-signals)
- [Design decisions](../design/decisions.md) — why there is no fingerprinting here
- [The challenge](../challenge/index.md) — the other thing that runs in a browser
