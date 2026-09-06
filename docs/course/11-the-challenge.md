# Lesson 11 — The challenge

**Goal:** turn on proof of work, know exactly what it buys, and make sure it cannot become
a wall for somebody who did nothing wrong.

← [Course](index.md) · Prev: [Actions and presets](10-actions-and-presets.md) · Next: [Going live](12-going-live.md)

---

## What it actually buys

The client must find a counter such that `SHA-256(nonce + ":" + counter)` begins with
`difficulty` zero bits. Verification is one hash; solving takes about `2^difficulty` of
them.

**It does not identify anyone and it does not prove a human is present.** A headless Chrome
solves it as readily as a person's phone, just paying for the CPU.

What it does is convert a scrape from free into merely cheap, and change the *shape* of the
attack: a stateless scraper pulling a million pages must now run a JavaScript engine and
burn CPU on every one. Often that is enough to make bulk extraction not worth doing, and it
costs a real visitor a fraction of a second, once.

That is precisely why it sits where it does on the [action ladder](10-actions-and-presets.md).
It is the heaviest thing the [guard](04-the-guard.md) will let a *probabilistic* verdict ask
for, because a client wrongly suspected can pass it on its own and carry on.

## Do this

Remember lesson 4, where a rule asking to block got `tag` instead? That was because no
challenge was configured. Fix it:

```js
import { BotHandler, createFacts } from "@osqd/bothandlerjs";

const detector = new BotHandler({
  challenge: {
    secrets: [process.env.SERIF_CHALLENGE_SECRET],   // at least 32 characters
    contactHtml: '<p>Locked out? Email <a href="mailto:help@serif.example">help@serif.example</a>.</p>',
  },
  rules: [
    { id: "suspected-challenge", match: { verdict: "suspected-bot", minScore: 40 }, action: "challenge" },
  ],
  suspectThreshold: 40,
});

const spoof = createFacts({
  method: "GET", url: "/books", ip: "203.0.113.55",
  headers: { host: "serif.example", "user-agent": CHROME["user-agent"], accept: "*/*" },
});

const result = await detector.handle(spoof);
console.log(result.outcome.kind, result.outcome.status);
```

### Checkpoint

```
respond 429
```

`handle` does assess, decide and act in one call, and returns an `ActionOutcome` for an
adapter to apply. The interstitial is a `429` with a locked-down CSP — `default-src 'none'`
and a nonce for its own script. No external resource of any kind appears on it.

## The secret has no default, on purpose

A library-supplied fallback secret is a library-supplied forgery key, and it would end up in
production somewhere. Without `secrets`, a rule asking for a challenge degrades to `tag` and
says so through `onWarning`. Secrets must be at least 32 characters; shorter throws at
construction.

Rotating: the **first** secret signs, **all** of them verify. Prepend a new one, keep the
old for a token lifetime, and nobody is logged out.

```js
challenge: { secrets: [NEW_SECRET, PREVIOUS_SECRET] }
```

## `contactHtml` is the most valuable line here

Everyone who sees the no-JavaScript fallback is a person your site just turned away: no
JavaScript, no WebCrypto, or a device too slow to finish. Put a real support address, a
phone number, or a link to a form there.

The default text is honest but generic. Yours can name a human.

## Difficulty

In *bits*, so each step doubles the work. Default 16 — about 65,000 hashes, tens of
milliseconds in a modern browser. Refused above 24.

Past about 20 you are charging real people a visible delay, and **the oldest and slowest
devices pay the most** — which disproportionately means the users least able to replace
them. Raise it during an incident, not as a posture.

## What a clearance proves

Solving grants a signed cookie that the `clearance` detector reads afterwards. It carries a
**level**, and the level is what a rule should key on:

| Level | Demonstrated | Certainty |
| ----- | ------------ | --------- |
| `pow` | ran JavaScript, has WebCrypto, spent CPU | not conclusive |
| `interaction` | a trusted input event was observed | stronger, still forgeable by a driven browser |
| `operator` | **your application** said this is a person | `certain` |

Only `operator` is conclusive, because that assertion comes from you rather than from the
client. You grant it yourself:

```js
detector.grantClearance(facts, "operator");   // e.g. just after a successful sign-in
```

That is the only conclusive human signal that exists anywhere in this library.

## The one piece of state

The lifecycle is deliberately stateless until the moment of success: a challenge is a signed
blob the client carries, so a flood of unsolved challenges costs nothing but the bytes to
send them.

Exactly one thing is written, at the one moment it is indispensable: the solved nonce is
**claimed atomically**, so a solution cannot be replayed. That claim lives in the store —
with the default in-memory one and several replicas, a scraper retries a solved nonce
against other instances until one has not seen it. [Lesson 14](14-scaling.md).

## Two refusals

**Challenging an actor that already holds valid clearance** is refused and warned about.
Passing a challenge cannot change a proven verdict, so re-issuing would loop for ever.

**Challenging on an API** breaks your customers' integrations and stops nobody — see
`protect-api` in [lesson 10](10-actions-and-presets.md).

## Asking for a gesture as well

The proof of work shows a JavaScript engine ran. One option asks for two more things — a
deliberate gesture, and evidence that a *browser* rendered the page:

```js
challenge: {
  secrets: [process.env.SERIF_CHALLENGE_SECRET],
  contactHtml: "<p>…</p>",
  interaction: true,
}
```

The interstitial grows a checkbox, and six probes read back things only a rendering engine
produces — a computed style that needs the cascade to have run, a laid-out box, font
metrics, a frame loop. **Solving the puzzle alone no longer grants clearance**: the gesture
is required, and passing grants the stronger `interaction` clearance rather than `pow`.

The control is a checkbox rather than a slider or a puzzle for one reason: it is the only
interactive element every way of using a computer can operate — pointer, touch, the space
bar, a screen reader, switch access, voice control.

**Be clear about what it buys.** It does not prove a person. What it does is move a scraper
from `fetch()` in a loop to running a browser engine and rendering CSS per request, which
is three or four orders of magnitude more expensive. Exactly one signal in the exchange is
server-verified and cannot be faked: the elapsed time between issuing the challenge and
receiving the answer, taken from the signed token.

Watch it with the counters it emits — `bothandler_clearances_total{level=…}`,
`bothandler_challenge_rejections_total{cause=…}` and `bothandler_interaction_score_bucket`.
Without the score distribution, moving the threshold is guessing.

See [the interaction challenge](../challenge/interaction.md) for the full account,
including where its movement analysis stops working.

## Unsolved challenges as a signal

Every issued-and-never-solved challenge is counted on the [actor](07-actors.md):

```js
{ id: "persistent-refusal", match: { minUnsolvedChallenges: 5 }, action: "block" }
```

It is **not evidence**, deliberately. One abandoned challenge is a person who changed their
mind; what five of them mean is a judgement about your traffic that only you can make.

## Speaking the visitor's language

The interstitial is the only page this library shows to a member of the public, and they
are seeing it because a *probabilistic* verdict went against them. Somebody who cannot read
it cannot find the contact link on it either — which turns a check into a wall.

```js
challenge: {
  secrets: [SECRET],
  contactHtml: "<p>…</p>",
  translations: {
    ja: { title: "ブラウザーを確認しています", message: "数秒で完了します。" },
    de: { title: "Browser wird überprüft" },
    "pt-BR": { title: "Verificando seu navegador" },
  },
}
```

The library ships **no translations and will not**: a machine-translated apology on a page
that just turned somebody away is worse than an honest English one, and only you know which
languages your audience reads. Anything a translation omits falls back to the default, so a
`title`-only entry is a fine first step.

Matching is exact tag first, then primary subtag — and it stops there. `pt-PT` is **not**
handed `pt-BR`. That looks unhelpful until you consider the case it protects: serving
Simplified Chinese to somebody who asked for Traditional is a worse failure than serving
English, and no rule can tell the two apart. Whether one regional variant stands in for
another is decided by which keys you write.

Each translation may set `lang`, which decides the voice a screen reader uses. Japanese
announced as `lang="en"` is unintelligible; getting the copy right and the attribute wrong
helps nobody.

## Exercise

Serif serves readers in Britain, Brazil and Japan. Configure the challenge so that none of
them hits a wall, and say what happens to a Portuguese reader in Lisbon.

<details>
<summary>Answer</summary>

```js
challenge: {
  secrets: [process.env.SERIF_CHALLENGE_SECRET],
  contactHtml: '<p>Locked out? Email <a href="mailto:help@serif.example">help@serif.example</a>.</p>',
  translations: {
    "pt-BR": { lang: "pt-BR", title: "Verificando seu navegador", message: "Isso leva alguns segundos.",
               contactHtml: '<p>Problemas? <a href="mailto:help@serif.example">Fale conosco</a>.</p>' },
    ja: { lang: "ja", title: "ブラウザーを確認しています", message: "数秒で完了します。",
          contactHtml: '<p>お困りですか？<a href="mailto:help@serif.example">サポート</a>へご連絡ください。</p>' },
  },
}
```

**The Lisbon reader gets English.** `pt-PT` matches no exact key, and the primary-subtag
step looks for `pt`, which you did not supply — `pt-BR` is a regional variant and will not
stand in for another.

If Serif wants European Portuguese readers covered by the Brazilian copy, that is a
judgement about the audience, and it is made by **filing the copy under `pt`** rather than
`pt-BR`. The library will not make it for you.

Note that every translation carries its own `contactHtml`. A translated "checking your
browser" over an English "email us" is half a fix.
</details>

## What you learned

- Proof of work imposes cost; it proves neither identity nor humanity
- The secret has no default because a default secret is a forgery key
- Difficulty is in bits, and the slowest devices pay most
- Only `operator` clearance is conclusive, and only you can grant it
- `minUnsolvedChallenges` is a rule, not evidence
- The interstitial is public-facing: give it a real contact and a language people read

## Reference

- [The challenge](../challenge/index.md) · [The interaction challenge](../challenge/interaction.md) · [Localisation](../challenge/localisation.md)
- [Actions](../policy/actions.md) — where `challenge` sits

Next: [Going live](12-going-live.md).
