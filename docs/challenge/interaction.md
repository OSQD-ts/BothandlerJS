# The interaction challenge

A gesture and a browser examination, on top of the proof of work — and a precise account
of what that is worth.

← [Documentation](../index.md) · [The challenge](index.md)

---

## What it adds

The [proof of work](index.md) demonstrates that a JavaScript engine ran. This asks for two
more things:

1. **A deliberate gesture** — a checkbox the visitor ticks.
2. **Evidence that a browser rendered the page** — six probes that read back things only a
   real rendering engine can produce.

Turn it on with one option:

```ts
new BotHandler({
  challenge: {
    secrets: [process.env.CHALLENGE_SECRET!],
    contactHtml: '<p>Locked out? Email <a href="mailto:help@example.com">help@example.com</a>.</p>',
    interaction: true,
  },
});
```

**Solving the puzzle alone no longer grants clearance when this is on.** The gesture is
required. Read [what it costs people](#what-it-costs-people) before you enable it.

---

## What is actually verifiable

Everything the page reports is client-supplied, and the client is the one place an
adversary has complete control. Being precise about this is the difference between a
security control and a decoration.

| Signal | Who says so | Can it be faked? |
| ------ | ----------- | ---------------- |
| **Elapsed time between issue and answer** | **the server**, from the signed token's `iat` | **no** |
| `isTrusted` on the activation | the client | yes, by a browser driven through CDP |
| Capability probes | the client | yes, by actually having a browser — which is the point |
| Pointer path | the client | yes, with deliberate effort |

Exactly one row is server-verified. The rest raise cost rather than establish fact.

### The ceiling

Every probe here is answered by the client, and every value a probe asks about has to reach
the browser in order to be rendered. So anything willing to **parse the page it was served**
can answer without rendering anything. Measured, five challenges each:

| A client that… | Gets |
| -------------- | ---- |
| replays a report captured from a real browser | **0/5** |
| hardcodes a formula for the layout probe | **0/5** |
| **parses the served HTML and CSS each time** | **5/5** |
| actually renders the page | 5/5 |

Read the third row carefully. Against an adversary who writes a parser for your challenge
page, the interaction challenge adds **nothing over the plain proof of work except the
server-verified elapsed-time floor**. It is not a defence against somebody targeting you
specifically, and no client-side probe can be.

**What it does buy**, and this is worth having: it defeats every scraper that does not
bother — off-the-shelf tooling, `fetch()` in a loop, a report captured once and replayed, a
naive headless driver with a lerped mouse path. That is the overwhelming majority of
automated traffic, and for bulk extraction it is often the difference between worth doing
and not.

Nothing here is proof of humanity, and none of it is ever `certain`. If you need a bar an
adversary cannot step over by writing a parser, the bar is an account, not a challenge.

---

## The capability probes

Each reads back something that only exists if a rendering engine produced it. An HTTP
client that parsed the HTML has no answer to any of them.

One of them is different for every challenge. **The layout probe** asks the page to lay out
a block whose box count and box height are both drawn from the challenge's nonce **under the
signing secret**, and to report the measured height. The client cannot compute that answer;
it can only measure it.

An earlier version fixed the height at 7px in the stylesheet and derived the count from the
nonce in the page's own script, which made the answer a formula an attacker reads once and
hardcodes for ever — a client that never rendered anything answered it correctly five times
out of five.

That closes a hole the other probes leave wide open. Every other answer in a report is the
same from one challenge to the next, so a report captured once from a real browser could be
replayed against fresh challenges for ever: solve the puzzle headlessly, paste the blob,
and never run a browser again — skipping precisely the cost this feature exists to impose.
Measured before the probe existed, one captured report was accepted for **five consecutive
challenges**; with it, for one.

It is still not proof against somebody who parses the page: both numbers have to reach the
browser to be rendered, so a parser can find them. What it removes is the *formula* — there
is no longer a fixed rule to implement once and reuse — and what it stops outright is
*replay*. See [the ceiling](#the-ceiling).

| Probe | Weight | What it asks |
| ----- | -----: | ------------ |
| `cssApplied` | 0.30 | A computed `letter-spacing` that only exists if a CSSOM parsed the stylesheet and ran the cascade |
| `layout` | 0.20 | A laid-out element has a non-zero box |
| `fontMetrics` | 0.15 | The same string in two families measures differently — there is a font engine |
| `animationFrame` | 0.15 | Two frames arrive, a plausible interval apart |
| `mediaQuery` | 0.10 | A media query evaluates against a real viewport |
| `hiddenIsHidden` | 0.10 | `display: none` is honoured, not merely parsed |

`cssApplied` carries the most weight because it is the one that separates *the population
this challenge is aimed at* — HTTP-client scrapers — from browsers. A real browser passes
every probe, including a headless one; that is expected and is the cost being imposed.

---

## Reading the pointer

When the checkbox is ticked with a pointer, the page sends a bounded, quantised record of
the movement leading up to it — a rolling window of the **most recent** 128 samples of
`[dx, dy, dt]`, rounded to two decimal places. Most recent matters: a fixed buffer that
stopped accepting samples once full kept a reader's idle wandering and discarded the
approach to the control, which is the one movement the analysis exists to recognise. **The analysis runs on the server.** A page that scored itself would simply
be asked to report a good score.

Five properties are measured, and they are weighted by *what they cost an attacker who is
trying*:

| Property | Weight | Naive path | A hand |
| -------- | -----: | ---------- | ------ |
| Distance per sample | 0.30 | 0.00 | ~0.60 |
| Straightness | 0.25 | 1.00 | ~0.85 |
| Speed variation | 0.15 | 0.00 | ~0.98 |
| Timing jitter | 0.10 | 0.00 | ~0.50 |
| Acceleration changes | 0.10 | 0 | many |
| Sub-pixel coordinates | 0.10 | none | most samples |

**Distance per sample carries the most, and speed carries less than it looks like it
should.** Speed is distance over time, so jittering the event timing alone manufactures
speed variation for free — 0.33 on a perfectly straight constant-step path, measured — and
ragged dispatch timing is exactly what an awaited automation loop produces without trying.
Distance per sample reads only where the pointer went, so a constant-step path scores zero
however uneven its timing.

The last two terms are worth little on purpose: bolting random noise onto a straight line
maxes both out immediately and is nearly free.

A **discontinuity is excluded rather than measured**. A sample arriving more than 250 ms
after the last one is the pointer reappearing — entering the window, coming back from
another application, or simply resting — and the distance across that gap is not a distance
a hand travelled. This matters more than it sounds: a perfectly even synthetic path
measured through a real browser scored 0.76 on distance variation, indistinguishable from a
person, because of exactly one sample — the pointer's first appearance, a 60×60 jump
recorded 1.25 s after load. One outlier in twenty-six.

### How much this actually separates

Fed paths directly, the analysis discriminates sharply:

| Path | Movement score |
| ---- | -------------: |
| Constant-velocity interpolation | **0.00** |
| The same line with random jitter | **0.38** |
| A short, quick human move | **0.69** |
| A full human move | **0.93** |

Driven through a **real browser**, it discriminates much less:

| Through Chromium | Movement | Composite |
| ---------------- | -------: | --------: |
| A person-like move | 0.75 | 0.90 |
| Evenly-stepped automation | 0.56 | 0.83 |

That gap is not wide enough to sit a threshold in, and raising `interactionAt` to catch the
second row would start refusing the first. **So be clear about what the movement analysis
is for:** it raises the bar for a client that *fabricates* a report without a browser —
where a lazy path scores 0.00 — and it is only a weak tiebreaker between two clients that
both really are browsers. The signals doing the load-bearing work against a real browser are
the server-verified elapsed time and the capability probes.

---

## How the clearance is graded

```
score = capabilities × 0.6  +  movement × 0.4
```

| Outcome | Result |
| ------- | ------ |
| No interaction reported | **refused** |
| `isTrusted` false | **refused** |
| Answered faster than `minElapsedMs` | **refused** |
| Client claims it took longer than the challenge has existed | **refused** |
| The path describes more movement than the challenge lasted | **refused** |
| The layout probe is unanswered, or answers a different challenge | **refused** |
| Score below `refuseBelow` (0.2) | **refused** |
| Score at or above `interactionAt` (0.75) | `interaction` clearance |
| Anything in between | `pow` clearance |

`bothandler_interaction_score_bucket` counts refusals as well as successes. A distribution
fed only from what already passed has everything below the threshold cut out of it, which
is the part of the shape the threshold decision actually turns on.

Rejections name the probes that failed rather than only counting them — `capabilities 70%
(missing: fontMetrics, animationFrame)`. A percentage says something is wrong; the names say
whether it is bots or a population whose browsers cannot answer one particular question, and
those call for opposite responses.

`interactionAt` is set from measurement rather than taste. Fed a fabricated
constant-velocity path a client scores **0.60**, and a person in a browser scores **0.90**;
the bar sits between them. It does **not** separate crude automation inside a real browser
from a person — see the table above — and it is not set as though it does.

The [`clearance` detector](../detection/detectors.md) then reads the level: `interaction`
is `strong` human evidence at weight 0.7, `pow` is `moderate` at 0.45.

### A keyboard is never penalised

A pointer path is worth something, and its **absence is worth nothing either way**. Voice
control produces no pointer movement. Switch access produces machine-regular timing. A
screen reader activates the control from the keyboard.

Scoring those down would put assistive technology on the wrong side of a check the rest of
this library exists to keep people out of. So a keyboard or unclassified activation is
graded on its capabilities and its timing alone.

The consequence, stated plainly: **claiming keyboard activation is the cheapest way
through, and it costs a real browser.** That is the floor this feature raises, and it is
deliberate. The alternative — penalising the absence of mouse movement — refuses people
for how they use a computer.

A **tap is not a mouse**, and is reported as its own thing. Touch produces almost no
`pointermove` — one sample, frequently none — so classifying a tap as a pointer would score
it zero for movement and quietly grade every phone down to the weaker clearance. The page
reads `click.detail`, which the platform sets to 0 for a keyboard activation and to the
click count for a pointer, and takes the device from `pointerdown`.

A path **too short to describe is no evidence, not bad evidence**. Somebody whose cursor
already rested on the control, or who nudged it a few pixels, is graded on capabilities like
a keyboard or a tap.

Scoring that as zero was tried first, on the reasoning that a pointer activation showing no
movement describes something that did not happen. Measured, it was wrong in both directions
at once: it downgraded honest clients, and it caught nobody — `via` is a field the client
fills in, so an attacker with no path to show simply writes `keyboard` and is graded on
capabilities like everybody else. A rule that only ever costs honest people something is not
strictness.

The discrimination that does work is untouched: a path of four samples or more that looks
interpolated scores zero, and that is a claim about movement the client *did* report.

---

## Tuning

```ts
challenge: {
  secrets: [SECRET],
  interaction: {
    minElapsedMs: 1000,   // server-measured floor between issue and answer
    interactionAt: 0.75,  // at or above this, grant `interaction`
    refuseBelow: 0.2,     // below this, refuse outright
  },
}
```

**`challengeTtlMs` defaults to ten minutes when the gesture is on**, rather than the two
the plain challenge uses. Two minutes is the right budget for a puzzle a machine solves in
milliseconds; it is the wrong one for a page that stops and waits for a person to read it
and act. Somebody using a screen reader that announces the whole page, on a slow device
where the proof of work itself takes twenty seconds, or simply interrupted, runs out and is
told to reload — having done nothing wrong and with no way to know why.

`minElapsedMs` is the one worth raising during an incident. It is server-verified, so it is
a hard ceiling on how fast a farm can work through challenges however many browsers it
runs — and it costs a real visitor nothing, because a person takes longer than a second to
read a page and tick a box anyway.

---

## What it costs people

The gesture is a **checkbox**, and that choice is the whole accessibility argument. It is
the one interactive control that every way of using a computer can operate: pointer, touch,
the space bar, a screen reader, switch access, voice control. A slider, a press-and-hold or
an image puzzle would each exclude somebody.

The interstitial with the gesture is axe-audited in both themes at every release, the
control has a real `<label>`, and the page moves focus to it when the puzzle finishes so
that a keyboard user is put on the one remaining action rather than having to go looking.

**Who still cannot get through:** anyone without JavaScript or WebCrypto, and anyone whose
browser cannot run the probes — a text-mode browser, for instance. They could not complete
the plain proof of work either, so this changes nothing for them, and `contactHtml` remains
their route. Supply a real one.

When the page gives up, **it withdraws the checkbox** rather than leaving it on screen. A
live control that cannot work offers a way through that does not exist, and it is worst for
somebody using a screen reader, who would find it, activate it, and be told nothing.

## Why not an image puzzle

Because they no longer work and they exclude people.

Machine learning solves image grids more accurately than humans do, and solving farms
charge about a dollar per thousand — so a visual CAPTCHA adds friction for people and a
rounding error for attackers. It also locks out blind and low-vision users, motor
impairments and cognitive disabilities.

The [guard](../concepts/the-guard.md) permits a `challenge` on a *guess* precisely because
the client can pass it on its own. For somebody who cannot see the puzzle, that is not a
challenge — it is a block, delivered on a guess. This library will not ship one.

## Related

- [The challenge](index.md) — the proof of work this builds on
- [Localisation](localisation.md) — the interstitial in a language the visitor reads
- [Client signals](../detection/client-signals.md) — the same reasoning, on ordinary pages
- [Threat model](../concepts/threat-model.md) — what none of this can do
