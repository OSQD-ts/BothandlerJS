# The challenge

A proof-of-work interstitial: what it buys, what it does not, and how to wire it up.

← [Documentation](../index.md)

---

## What it actually buys, stated plainly

The client must find a counter such that `SHA-256(nonce + ":" + counter)` begins with
`difficulty` zero bits. Verification is one hash; solving takes on average `2^difficulty`
of them.

**It does not identify anyone and it does not prove a human is present.** A headless
Chrome solves it as readily as a person's phone, just paying for the CPU.

What it does is convert a scrape from free into merely cheap, and change the *shape* of the
attack: a stateless scraper pulling a million pages must now run a JavaScript engine and
burn CPU on every one. That is often enough to make bulk extraction not worth doing, and it
costs a real visitor a fraction of a second, once.

This is why the challenge sits where it does in the [action ladder](../policy/actions.md):
it is the heaviest thing the [guard](../concepts/the-guard.md) will let a *probabilistic*
verdict ask for, precisely because a client that is wrongly suspected can pass it on its
own and carry on.

---

## Turning it on

One thing is required and has no default:

```ts
import { BotHandler } from "@osqd/bothandlerjs";

const detector = new BotHandler({
  preset: "protect-content",
  challenge: {
    secrets: [process.env.BOT_CHALLENGE_SECRET!],
    contactHtml: '<p>Locked out? Email <a href="mailto:support@example.com">support@example.com</a>.</p>',
  },
});
```

A library-supplied fallback secret is a library-supplied forgery key, and it would end up
in production somewhere. Without `secrets`, a rule asking for a challenge degrades to a
`tag` and says so through [`onWarning`](../operations/notifications.md).

The [adapters](../integration/adapters.md) serve the verification endpoint for you. Nothing
else to mount.

### Rotating secrets

The first secret signs; all of them verify. Prepend a new one and keep the old for a token
lifetime, and nobody is logged out:

```ts
challenge: { secrets: [NEW_SECRET, PREVIOUS_SECRET] }
```

---

## Every option

| Option | Default | Notes |
| ------ | ------- | ----- |
| `secrets` | — | required; first signs, all verify |
| `difficulty` | `16` | leading zero bits; see below |
| `challengeTtlMs` | `120_000` | how long a challenge may be solved for |
| `clearanceTtlMs` | `3_600_000` | how long a granted clearance lasts |
| `verifyPath` | `/__bothandler/verify` | where the solution is POSTed |
| `cookieName` | `__bh_clearance` | |
| `cookieSecure` | `true` | set `false` only for local plaintext development |
| `cookieSameSite` | `"Lax"` | |
| `title`, `message` | English defaults | page copy |
| `contactHtml` | — | **supply something real** |
| `translations` | — | see [localisation](localisation.md) |

### Difficulty

In *bits*, so each step doubles the work. The default 16 is around 65k hashes — tens of
milliseconds in any modern browser. It is refused above 24.

Past about 20 you are charging real people a visible delay, and the oldest and slowest
devices — which disproportionately belong to the users least able to replace them — pay
the most. Raise it during an incident, not as a posture.

### `contactHtml`

Everyone who sees the no-JavaScript fallback is a person your site just turned away: no
JavaScript, no WebCrypto, or a device too slow to finish. Put a support address, a phone
number or a link to a form there. This is the single highest-value line of configuration on
this page.

---

## What a clearance proves

Solving grants a signed cookie, which the `clearance` [detector](../detection/detectors.md)
reads on subsequent requests. It carries a **level**, and the level is what a rule should
key on:

| Level | What was demonstrated | Certainty |
| ----- | --------------------- | --------- |
| `pow` | ran JavaScript, has WebCrypto, spent measurable CPU | not conclusive |
| `interaction` | a trusted input event was observed | stronger, still forgeable by a driven browser |
| `operator` | **your application** asserted this is a person | `certain` |

Only `operator` is treated as conclusive, because that assertion comes from you rather than
from the client. See [`isHuman`](../reference/configuration.md) for how to make one.

---

## The lifecycle, and the one piece of state

Deliberately stateless up to the moment of success. A challenge is a signed blob the client
carries; the server stores nothing while it is being solved, so a flood of unsolved
challenges costs nothing but the bytes to send them.

Exactly one thing is written, at the one moment it is indispensable: the solved challenge's
nonce is **claimed atomically**, so a solution cannot be replayed.

That claim lives in the [store](../integration/stores.md). With the default in-memory store
and several replicas, a scraper retries a solved nonce against other instances until one
has not seen it. Pass a `RedisStore` if you run more than one process.

## Two refusals worth knowing

**Challenging an actor that already holds valid clearance** is refused and warned about.
Passing a challenge cannot change a proven verdict, so re-issuing would loop for ever.

**Challenging on an API** is a mistake the [`protect-api` preset](../policy/presets.md)
deliberately avoids: an API client is not a browser, so a challenge breaks your customers'
integrations while an attacker solves it once in headless Chrome. Rate-limit instead.

## Unsolved challenges as evidence

Every issued-and-never-solved challenge is counted on the [actor](../concepts/actors.md).
A client that has been asked five times and never once finished has told you something,
and rules can read it:

```ts
{ id: "persistent-refusal", match: { minUnsolvedChallenges: 5 }, action: "block" }
```

## Related

- [The interaction challenge](interaction.md) — asking for a gesture, and probing the browser
- [Localisation](localisation.md) — showing the page in a language the visitor reads
- [Actions](../policy/actions.md) — where `challenge` sits on the ladder
- [The guard](../concepts/the-guard.md) — why it is the ceiling for unproven verdicts
- [Stores](../integration/stores.md) — why replay protection needs a shared one
