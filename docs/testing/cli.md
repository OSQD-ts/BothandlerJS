# The CLI

Five commands, no server, no installation.

← [Documentation](../index.md) · [Testing](index.md)

---

```
bothandlerjs replay <file> [options]   Replay an access log and report what would have happened
bothandlerjs check [--preset <p>]      Run a policy against the traffic corpus: who would it hurt?
bothandlerjs explain [request]         Assess one request and show the evidence behind the verdict
bothandlerjs robots [options]          Generate a robots.txt from a policy preset
bothandlerjs detectors [--preset <p>]  List the detectors a configuration installs
```

---

## `explain`

The question that arrives by ticket rather than by traffic.

```bash
bothandlerjs explain "curl/8.4.0"
pbpaste | bothandlerjs explain --preset protect-data
bothandlerjs explain --ip 203.0.113.9 --url /checkout "Mozilla/5.0 ..."
```

It takes a User-Agent, a `curl` command copied out of devtools, or a raw header block — from
an argument or from stdin — and prints the verdict, the rule that would fire, and every
piece of [evidence](../concepts/evidence.md) behind it.

It runs as a **[dry run](../detection/index.md)**, so nothing is recorded and asking does
not change the answer. It has no history by construction, so what it answers is *what would
this look like as a first request* — which is what a ticket is asking anyway.

## `check`

The CI step.

```bash
npx bothandlerjs check --preset protect-content
```

```
  protect-content against 522 shapes of real traffic

  human            181 cases   3 tag, 175 allow, 3 challenge
  benign-bot       144 cases   6 allow, 86 tag, 48 block, 2 challenge, 2 rate-limit
  declared-bot      32 cases   18 tag, 2 rate-limit, 3 allow, 9 block
  unwanted-bot     105 cases   8 tag, 11 rate-limit, 3 block, 70 challenge, 13 allow
  hostile           27 cases   6 challenge, 17 block, 4 allow
  infrastructure    33 cases   7 allow, 12 tag, 14 challenge

  No case marked as a person was denied service.
```

The question this library is organised around, asked before a deploy rather than after one:
*if I point this configuration at the actual internet, who gets hurt?*

**It exits non-zero if any case marked `human` is denied service**, which is what makes it a
CI step rather than a report.

| Option | |
| ------ | - |
| `--preset <name>` | which policy to test (default `protect-content`) |
| `--audience <a>` | `human` \| `benign-bot` \| `declared-bot` \| `unwanted-bot` \| `hostile` \| `infrastructure` |
| `--json` | the scorecard, for a pipeline |
| `--strict` | also fail on differing actions, not only the invariants |

`--audience human` is the one to reach for first: it shows only the part that matters.

See [the corpus](corpus.md) for what it is running against.

## `replay`

Your policy against your own traffic. See [log replay](replay.md) — including the reason
JSON Lines is much better than CLF.

```bash
npx bothandlerjs replay /var/log/nginx/access.log --preset protect-content
```

| Option | |
| ------ | - |
| `--preset <name>` | default `protect-content` |
| `--limit <n>` | stop after n parsed lines |
| `--show <n>` | how many would-be-denied requests to print in full (default 10) |
| `--format <f>` | `clf` \| `json` (detected from the first line by default) |
| `--json` | the report, machine-readable |

## `robots`

```bash
bothandlerjs robots --preset decline-ai-training --sitemap https://example.com/sitemap.xml > public/robots.txt
```

Generates a `robots.txt` from a preset's rules (default preset: `protect-data`), with the
trap paths disallowed for you.

Notes about rules that could not be reflected go to **stderr**, so a redirect into the file
stays clean while the reasoning still reaches whoever ran the command. Read them — see
[robots.txt](../policy/robots.md) for why an unreflected rule matters.

## `detectors`

```bash
bothandlerjs detectors --preset protect-api
```

Lists what a configuration actually installs, with each detector's cost and stage. Useful
for the question "is `identity-rotation` on?", which has caused more confusion than any
other single setting.

## Related

- [The corpus](corpus.md) · [Log replay](replay.md)
- [Detectors](../detection/detectors.md) — what `detectors` is listing
- [robots.txt](../policy/robots.md) — what `robots` is generating
