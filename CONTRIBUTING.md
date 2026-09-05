# Contributing

Thanks for looking. A few things about this codebase are unusual and worth knowing
before you write a patch.

## The one rule that is not negotiable

**`certain` means deterministic.** A piece of evidence may only be `certain` if there
is no benign explanation for it — and you must be able to write that explanation down
in the `deterministicBasis` field. If you cannot, the correct tier is `strong`.

This is not stylistic. The `certain` tier is the only thing that can get a request
blocked, and the whole value of the library is that the tier means something. A single
detector that promotes a good heuristic to `certain` because it feels conclusive
converts this from "never blocks on a guess" into "blocks on guesses, with extra
paperwork".

A useful test: *could a real person, using unusual but legitimate software, produce
this observation?* Privacy browsers, corporate proxies, accessibility tooling, old
devices, carrier transcoders and VPNs all count. If yes, it is probabilistic.

A worked example, from a bug this repository actually shipped. `Electron/` sat in the
headless signature set, which `self-identified` treats as `certain` on the grounds
that "no browser sends this". The claim is false: Electron is an *application*
framework, and VS Code's Simple Browser, Slack, Discord, Postman and Notion all embed
a real Chromium with a person driving it. The result was that opening the project's
own demo in VS Code produced a proven-automation verdict for a human reading a page —
and, because a challenge cannot undo a proven verdict, an infinite challenge loop.

Two lessons worth carrying: the justification written in `deterministicBasis` is the
thing to attack when reviewing, not the signal's accuracy in the common case; and a
signature is a claim about a *population* of clients, so ask who else sends the token
before deciding what tier it earns. `BotSignature.conclusive: false` exists for
exactly this case.

## Adding a detector

1. One file in `src/detectors/`, a factory returning a `Detector`.
2. Return `Evidence`, never a verdict. Combining is the engine's job.
3. Pick the tier honestly, and say in the doc comment *why* it is not higher. Those
   comments are the most valuable documentation in the repository.
4. Mark it `cost: "io"` if it touches the network or a shared store.
5. Export it from `src/detectors/index.ts`. Add it to `defaultDetectors()` only if it
   is safe for everyone by default — if it needs configuration to be meaningful, or
   misfires under the default IP-based actor key, leave it out and explain that in the
   doc comment (`identityRotationDetector` is the model).
6. Add a test that it does **not** fire on the genuine Chrome request in
   `tests/helpers.ts`. That test exists to protect real users and every detector owes
   it a case.

## Style

Match what is there. The house conventions:

- ESM with `.js` import specifiers, `import type` for types.
- Factory functions returning plain objects; options interfaces with `??` defaults.
- Strict TypeScript including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. `npm run typecheck` covers src, tests and examples.
- Zero runtime dependencies. External clients (Redis, notification services) are
  described structurally and injected, never imported.
- Comments explain *why*, especially why something is not stronger, faster or stricter
  than it looks like it should be. Comments that restate the code get deleted.

## The dashboard's browser code

`src/dashboard/client/` is a real TypeScript module, type-checked under
`tsconfig.browser.json` (the one project that speaks DOM) and bundled into
`src/dashboard/client.generated.ts` by `npm run client:build`. `page.ts` stamps that
string into the page's one nonced `<script>`.

The build runs automatically before `npm test`, `npm run typecheck` and `npm run
build`, and the generated file is committed so a fresh checkout can `tsx demo/server.ts`
without a build step. `npm run client:check` fails if it has drifted.

Two rules there are enforced rather than trusted, because every value that page renders
is written by the client being assessed:

- **Nothing reaches the document except through `textContent`.** The bundler refuses to
  emit `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`, and a test
  asserts the served page contains none of them.
- **No inline `style` attributes.** The page runs under a nonce CSP that blocks them;
  set geometry through the CSSOM (`el.style.width`), which is allowed.

Anything pure — the search, the outcome classification, the rule drafting, the replay
formats — belongs in a module that imports nothing from `dom.ts`, so it can be unit
tested in `tests/dashboard-client.test.ts` without a browser. The behavioural half is
`tests/browser/`, which drives a real Chromium and needs `npx playwright install` once.

That suite also runs **axe** against all four screens and fails on anything it rates
serious or critical. Two defects came out of it that nobody had noticed by looking: a
solid button whose white label sat at 3.9:1 on the series blue, and feed rows that were
`role="button"` with a link inside them. If you add a form control, give it a label the
`label()` helper can associate — a caption sitting next to an input is a label to
somebody who can see the layout and silence to everybody else.

## Bounds

Anything keyed by client-controlled input needs a bound, and anything parsed from a
request needs a length cap. An unbounded map keyed by IP is a remote OOM. If you add
per-actor state, add it to the budget arithmetic in `src/state.ts` and update the
memory note in the README.

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
npm run test:browser   # if you touched the dashboard page or its client
npm run bench:guard    # if you touched anything on the assess path
```

`bench:guard` budgets the hot path in **ratios against a reference loop measured in the
same process**, not in microseconds: a number recorded on a laptop means nothing on a CI
runner, and a check that fails for reasons unrelated to the code is a check people
disable. The budgets sit at roughly double what the code costs today, so they catch a
regression rather than an argument. If a change makes one legitimately larger, raise it
there and say why in the commit.

New behaviour needs a test. Changes to the certainty model, the safety guard, or IP
parsing need several, including the failure cases — those three are where a bug
becomes someone's outage or someone's lockout.

## Releasing

```bash
npm version patch      # or minor / major — bumps package.json, commits, tags
git push --follow-tags
```

That is the whole release. Pushing a `v*` tag starts `.github/workflows/publish.yml`,
which re-runs the full gate against that exact commit, checks the tarball, and publishes
to npm with provenance.

A push to `main` publishes nothing. npm releases cannot be withdrawn after 72 hours and a
version number can never be reused, so the trigger is a deliberate act rather than a side
effect of merging.

Three things it refuses to do, each because the failure is worse than the delay:

- **Publish a tag that disagrees with `package.json`.** The registry would get one number
  and the history another, and afterwards nobody can tell which commit a version came
  from.
- **Publish a version that already exists.** Registry versions are immutable, so this is
  an error rather than a no-op — and a failed publish reads as a broken pipeline when the
  truth is that the work was already done. The guard makes a re-run safe.
- **Publish something that has not just passed.** A tag is a pointer and can be written
  by hand or moved, so "CI was green on main" is a different statement from "this commit
  is green". The verify job makes the second one.

Update `CHANGELOG.md` before tagging. Run the workflow by hand from the Actions tab to
rehearse one — it defaults to a dry run that packs and checks everything and publishes
nothing.

Publishing needs an `NPM_TOKEN` secret — an npm **automation** token, so that two-factor
does not block CI — available to this repository at the organisation level. Provenance
needs nothing but the `id-token: write` permission the workflow already asks for; it
records in a public log which workflow, in which repository, built the tarball from which
commit, so somebody installing a bot-detection library can check where it came from.
