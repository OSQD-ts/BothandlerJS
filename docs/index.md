# Documentation

**bothandlerjs** — bot traffic detection and handling for TypeScript.

← [Back to the README](../README.md)

---

## Start here

**New to this?** [**The course**](course/index.md) teaches every capability in sixteen
lessons, in the order that makes each one make sense, with something to run at every step.
The pages below are the reference: they answer "how does X work?" rather than "what do I do
next?".

| | |
| --- | --- |
| [The course](course/index.md) | Sixteen lessons, one running example, from first assessment to a policy you can defend. |
| [Installation](start/installation.md) | Install it, and what it needs from your runtime. |
| [Your first integration](start/first-integration.md) | Ten lines that assess traffic, and what each one does. |
| [Choosing a policy](start/choosing-a-policy.md) | Pick a preset, prove it against your own traffic, then deploy it. |
| [Upgrading](start/upgrading.md) | What changed between versions, and what you have to do about it. |

## The ideas the library is built on

Read these once and everything else follows from them. They are short.

| | |
| --- | --- |
| [Evidence and certainty](concepts/evidence.md) | The two tiers, why they combine by different rules, and what "proof" means here. |
| [Verdicts, classes and scores](concepts/verdicts.md) | What the engine concludes, and which field you should actually be reading. |
| [The safety guard](concepts/the-guard.md) | The thing that stops a guess closing a door. The central mechanism. |
| [Actors and behavioural memory](concepts/actors.md) | Who "the same client" is, what is remembered about them, and for how long. |
| [Threat model](concepts/threat-model.md) | What this defends against, what it does not, and what it costs to be wrong. |

## Detection

| | |
| --- | --- |
| [How detection works](detection/index.md) | The pipeline: stages, budgets, failure, and what an assessment contains. |
| [The detectors](detection/detectors.md) | All twenty, each with what it reads, why it exists, and what it costs. |
| [The signature database](detection/signatures.md) | How a client is recognised by name, and what a name is worth. |
| [Verifying a crawler](detection/verification.md) | Reverse DNS, published address ranges, and refuting a forgery. |
| [Browser signals](detection/client-signals.md) | The optional page script, and the ceiling on anything it reports. |
| [Writing a detector](detection/writing-a-detector.md) | The contract, and the rules about certainty you have to keep. |

## Policy

| | |
| --- | --- |
| [Policy overview](policy/index.md) | Rules, order, and how a decision is reached. |
| [Matching requests](policy/rules.md) | Every field a rule can match on, with examples. |
| [Actions](policy/actions.md) | All ten, ordered by what each costs a client that turns out to be a person. |
| [Presets](policy/presets.md) | The eight shipped policies, and what each is for. |
| [robots.txt](policy/robots.md) | Generating the file your policy implies. |

## The challenge

| | |
| --- | --- |
| [The challenge](challenge/index.md) | Proof of work, clearance, and exactly what it buys. |
| [Languages](challenge/localisation.md) | Writing the interstitial in a language the visitor reads. |

## Running it

| | |
| --- | --- |
| [Operations overview](operations/index.md) | What to watch, and what to do when it moves. |
| [The dashboard](operations/dashboard.md) | What it shows, what it refuses to do, and every option it takes. |
| [Metrics](operations/metrics.md) | Counters, histograms and the Prometheus exposition. |
| [The traffic audit](operations/audit.md) | Watching the shape of your traffic rather than any one request. |
| [Notifications](operations/notifications.md) | Getting told, without being told a thousand times. |
| [Runtime changes](operations/runtime-changes.md) | Changing rules, the guard, ranges and actors without a deploy. |

## Integrating it

| | |
| --- | --- |
| [Integration overview](integration/index.md) | Where the library sits in a request. |
| [Adapters](integration/adapters.md) | Express, Fastify, Koa, Fetch, Hono, Next.js — and writing your own. |
| [Getting the client address right](integration/client-ip.md) | The highest-consequence setting in the library. |
| [Shared state](integration/stores.md) | What has to be shared between replicas, and what deliberately is not. |

## Proving it before it meets anybody

| | |
| --- | --- |
| [Testing overview](testing/index.md) | The three ways to find out what a policy does before it does it. |
| [The command line](testing/cli.md) | `replay`, `check`, `explain`, `robots`, `detectors`. |
| [The traffic corpus](testing/corpus.md) | 526 shapes of real traffic, and how to run your own config against them. |
| [Replaying your own logs](testing/replay.md) | The most useful thing you can do before deploying anything. |
| [Try it locally](testing/try-it.md) | A demo site, a live dashboard and eighteen scripted clients. |

## Reference

| | |
| --- | --- |
| [Configuration](reference/configuration.md) | Every option, with its default and its consequence. |
| [API](reference/api.md) | Every export, grouped by what it is for. |
| [Design decisions](design/decisions.md) | The things this library refuses to do, and why. |
