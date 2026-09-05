# The BotHandler course

Sixteen lessons that build one real integration, from a first assessment to a policy you
can defend.

← [Documentation](../index.md)

---

## What this is

The [reference documentation](../index.md) answers *"how does X work?"*. This answers
*"what do I do, and in what order?"* — every capability of the library, taught in the
order that makes each one make sense, with something to run at every step.

It is written to be worked through rather than read. Every lesson has code you paste and
output you can check yours against, and every checkpoint in it was produced by actually
running the code rather than by imagining what it would print.

**Time:** about four hours to do properly. Lessons 1–4 are the foundation and are worth
slowing down for; everything after them assumes you have those.

## Who it is for

A TypeScript or JavaScript developer who has a site or an API and a bot problem — or who
suspects they are about to have one. You need no background in bot detection. You do need
to be comfortable running `node` and reading a stack trace.

## The running example

You are building **Serif**, an online bookshop. It has a catalogue worth scraping, a
checkout worth attacking, and readers worth not annoying. Every lesson adds one thing to
Serif, and by lesson 16 you have a complete, tested, production-shaped configuration.

## Set up once

```bash
mkdir serif && cd serif
npm init -y && npm pkg set type=module
npm install @osqd/bothandlerjs
```

Every lesson's code goes in a file you run with `node`. Nothing needs a server until
lesson 11.

---

## Part 1 — The ideas everything rests on

| | | |
|-|-|-|
| 1 | [Your first assessment](01-first-assessment.md) | Turn a request into a verdict, and read what comes back. |
| 2 | [Proof and suspicion](02-proof-and-suspicion.md) | The distinction the whole library is built on. **The most important lesson here.** |
| 3 | [Verdicts, classes and scores](03-verdicts-and-scores.md) | Four fields describe a client. Which one should you act on? |
| 4 | [The safety guard](04-the-guard.md) | The mechanism that stops a guess closing a door. |

## Part 2 — Detection

| | | |
|-|-|-|
| 5 | [The detectors](05-detectors.md) | All twenty: what each reads, what each costs, what each may conclude. |
| 6 | [Identity and verification](06-identity.md) | Recognising a crawler by name — and proving or refuting the claim. |
| 7 | [Actors and behaviour](07-actors.md) | Who "the same client" is, and what watching one over time tells you. |
| 8 | [Traps](08-traps.md) | The one detector that needs no statistics, and how to lay one properly. |

## Part 3 — Deciding what to do

| | | |
|-|-|-|
| 9 | [Rules](09-rules.md) | Matching requests, in first-match-wins order. |
| 10 | [Actions and presets](10-actions-and-presets.md) | Ten responses, ordered by what each costs a person who did nothing wrong. |
| 11 | [The challenge](11-the-challenge.md) | Proof of work: what it buys, what it cannot, and who it must not exclude. |

## Part 4 — Production

| | | |
|-|-|-|
| 12 | [Going live](12-going-live.md) | Adapters, and the one setting that is dangerous to get wrong. |
| 13 | [Operating it](13-operating-it.md) | The dashboard, metrics, the traffic audit, notifications. |
| 14 | [Scaling and changing it live](14-scaling.md) | Several replicas, shared state, and editing policy without a deploy. |

## Part 5 — Making it yours, and proving it

| | | |
|-|-|-|
| 15 | [Extending it](15-extending.md) | Your own detector, action, signatures and browser signals. |
| 16 | [Proving it, and the capstone](16-proving-it.md) | The corpus, log replay, and a finished Serif you can defend. |

---

## How to get the most out of it

**Type the code, do not paste it.** The examples are short on purpose.

**Do the exercises before reading the answer.** Each one has a checkpoint so you know
whether you got it.

**When something surprises you, chase it.** Every lesson ends with links into the
reference documentation for the thing you just used. The surprises are usually where the
library is protecting you from something.

## A promise, and its consequence

One sentence holds this library together, and it will explain most of what surprises you:

> **Nothing is ever denied service on the strength of a guess.**

You will meet it first in [lesson 4](04-the-guard.md), where a rule you wrote asking to
block somebody quietly does something gentler instead. That is not a bug, and the lesson
explains why it is the most valuable behaviour here.

Start with [lesson 1](01-first-assessment.md).
