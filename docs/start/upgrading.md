# Upgrading

← [Documentation](../index.md) · [Getting started](../index.md)

---

## Versioning

Semantic versioning, with one clarification that matters for a library like this:

**A new detector, or a signature added to the database, is a minor release.** It can change
what your policy does to a request that was previously unrecognised — that is the point of
installing it — but it cannot change the [guard's](../concepts/the-guard.md) guarantee, and
it cannot turn a probabilistic verdict into a proven one.

**A change to how a tier is assigned is a major release.** Moving something from `strong` to
`certain` changes what may be denied, which is exactly the boundary this library exists to
hold still.

## Before you upgrade

Run your own configuration against the corpus and compare:

```bash
npx bothandlerjs check --preset protect-content --json > before.json
npm install bothandlerjs@latest
npx bothandlerjs check --preset protect-content --json > after.json
```

Or, for a configuration that is not a preset:

```ts
import { runCorpus } from "bothandlerjs/corpus";
const scorecard = await runCorpus({
  create: ({ resolver, clock }) => new BotHandler({ ...myConfig, resolver, clock }),
  assertActions: false,
});
```

The invariant — nothing marked as a person is denied — holds across versions and is checked
on every release. What can move is which *bots* a policy catches, and the scorecard shows
that as a diff rather than a surprise.

## 0.x

The library is pre-1.0. The engine, the evidence model, the guard and the policy grammar are
stable and are what everything else is built on; the surfaces most likely to change before
1.0 are the dashboard's options and the shape of the corpus scorecard.

Pin an exact version if you depend on either:

```json
{ "dependencies": { "bothandlerjs": "0.2.0" } }
```

## When a signature changes hands

Not a library upgrade, but the same class of problem: a crawler's published ranges go stale,
and a stale list turns a verified crawler into an accused impersonator.

```ts
import { startCrawlerRangeRefresh } from "bothandlerjs";
const stop = startCrawlerRangeRefresh(botHandler);   // twice a day
```

See [verification](../detection/verification.md) and
[runtime changes](../operations/runtime-changes.md).

## Related

- [The corpus](../testing/corpus.md) — the regression suite you can run yourself
- [Design decisions](../design/decisions.md) — what a future change would be undoing
