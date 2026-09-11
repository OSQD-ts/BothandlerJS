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

There is no release procedure. Merging to `main` is the release.

`.github/workflows/publish.yml` reads the commits since the last release tag, works out
what the version should be, and publishes `@osqd/bothandlerjs` to npm with provenance.
The only thing you have to get right is the commit message:

| Commit | Effect |
| ------ | ------ |
| `feat: …` | minor |
| `fix: …` / `perf: …` | patch |
| `feat!: …`, or a `BREAKING CHANGE:` footer | major — or minor, while the major is 0 |
| `docs:`, `ci:`, `test:`, `chore:`, `build:`, `refactor:`, `style:` | **nothing is published** |

That last row is what makes publishing on every push tolerable. A documentation fix
releases nothing, so the registry does not collect versions whose only difference is a
reworded comment. `node scripts/next-version.mjs --explain` prints the reasoning for the
current history, and `tests/next-version.test.ts` pins the rules — a `feat` read as a
patch would ship a feature as a bug fix, and nobody on a caret range would find out.

While the major version is 0, a breaking change bumps the **minor**. Reaching 1.0.0 is a
claim that the API is stable and should be made deliberately, not by a stray `!` in a
subject line.

### Saying the version outright

The table covers what the commits *imply*. Some releases are not implied by anything —
1.0.0 is a decision about stability rather than a consequence of a `feat`, a security fix
may want its own number, and a documentation-only push occasionally has to ship because
the last release went out with the wrong README. A commit footer says so:

```
docs: fix the install command the last release shipped

Release-As: 0.7.1
```

`Release-As:` takes an exact version, or one of `major`, `minor` and `patch` to force a
bump whatever the commits imply. It overrides the derived version in both directions,
including releasing a push that would otherwise publish nothing.

A footer rather than a button in the Actions tab, because the decision belongs in the
history: six months later, *"why is there no 0.9?"* is answered by `git log` rather than
by somebody's memory. Any commit in the range may carry one and the **newest wins**, so
changing your mind is one more commit rather than a force push. It has to be a footer —
mentioning `Release-As:` in a subject line, as this paragraph does, invokes nothing.

An override is checked rather than trusted. A value that is not a version or a bump, or
one that does not move forwards from the current version, **fails the release** instead of
quietly falling back to the derived number — the mistake being guarded against is somebody
mistyping the release they meant to cut and never finding out.

What the workflow does, in order: run the whole gate against that commit; work out the
version and stop if there is nothing to release; refuse a version already on the
registry, so a re-run is safe; set the version in `package.json` without committing it;
build, open the tarball and check every entry that has to be there is, and that it is
under 4 MB; publish; and only then commit `release: x.y.z [skip ci]`, push it, and tag
the commit that landed.

**Nothing reaches the remote until the package is on the registry.** It used to be the
other way round — commit, tag and push first, then build and publish — and twice that
left a tag on main for a version npm never received: 0.8.0, when the push raced
somebody else's, and 0.9.1, when its tarball came out over budget. A stranded tag is
worse than a failed run, because the next version is derived from the last tag, so it
quietly blocks every release after it. The tag is now made only once the release commit
has landed on main, which is also what makes a push that loses a race safe to retry.

Run it by hand from the Actions tab to rehearse — it defaults to a dry run, and a dry run
now pushes nothing at all. (It used to push a real release commit and tag every time.)

Publishing needs an `NPM_TOKEN` secret at the organisation level: an npm **automation**
token, so two-factor does not block CI, with publish rights to the `@osqd` scope.
Provenance needs only the `id-token: write` permission the workflow already requests.

Update `CHANGELOG.md` in the same commit as the change it describes, rather than at
release time — there is no release time any more.
