# Testing

Finding out what a policy does to your traffic before it does it.

← [Documentation](../index.md)

---

This library's central claim is that a bot policy is a claim about **your** traffic, and
that it should be checked rather than believed. Everything on these pages exists to make
that cheap.

| Page | Answers |
| ---- | ------- |
| [The CLI](cli.md) | "what is this one request?", "what does this policy do?" |
| [The corpus](corpus.md) | "who would this configuration hurt?" — 526 shapes of real traffic |
| [Log replay](replay.md) | "what would this have done to yesterday?" |
| [Try it](try-it.md) | "what does it look like running?" — the demo, the simulator, three dashboards |

---

## The order to use them in

1. **[`explain`](cli.md#explain)** — one request. The ticket that says "why was I
   challenged?".
2. **[`check`](cli.md#check)** — your policy against the corpus. This is the CI step. It
   exits non-zero if any case marked as a person is denied service.
3. **[`replay`](replay.md)** — your policy against your own access log. The corpus knows
   what the internet looks like; only your logs know what *your* visitors look like.
4. **[`monitor-only`](../policy/presets.md#monitor-only) in production** — for a week,
   watching [the dashboard](../operations/dashboard.md), before anything is enforced.

Step 4 is not optional and the other three do not replace it.

## Testing your own configuration, not a preset

The corpus is a published entry point:

```ts
import { runCorpus } from "@osqd/bothandlerjs/corpus";

const scorecard = await runCorpus({
  create: ({ resolver, clock }) => new BotHandler({ ...myProductionConfig, resolver, clock }),
  assertActions: false,   // your actions are yours; the invariants are not
});
if (scorecard.falsePositives.length > 0) throw new Error("this policy turns people away");
```

DNS is controlled rather than real and the clock is manual, so it is reproducible, offline,
and safe to run anywhere — including in CI, which is the point.

## Testing a detector you wrote

[Writing a detector](../detection/writing-a-detector.md) covers the contract; the corpus is
how you find out whether your new signal fires on 182 kinds of person as well as on the
thing you built it for. That is usually the surprising part.

## Related

- [Choosing a policy](../start/choosing-a-policy.md) — where these fit in the decision
- [The dashboard](../operations/dashboard.md) — the request tester, which is `explain` with a UI
