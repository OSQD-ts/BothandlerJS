# The feed filter

The search box above the live feed takes a small query language. It is the same language
everywhere it appears — the feed, the export, a shared link — so a filter that finds
something can be sent to somebody else and will find the same thing.

An empty query matches everything. Adjacent terms mean `AND`, because that is what
narrowing means — and `$or`, `$not` and set membership are there for when it is not.

## Terms

| Form | Means |
| --- | --- |
| `checkout` | the text appears anywhere in the request |
| `path:/api` | the path contains `/api` |
| `-path:/health` | the path does **not** contain `/health` |
| `"GET /api/v2/orders"` | the phrase, spaces and all |
| `score:>70` | a numeric comparison |

Negation is `-` or `!`, and works on any term. Quoting keeps spaces together, which is the
only way to search for a phrase.

## Operators

| Form | Means |
| --- | --- |
| `a $and b` | both — the same as writing them next to each other |
| `a $or b` | either |
| `$not a` | not — the same as `-a`, spelled out |
| `path:$in(/health, /metrics)` | the path contains any of these |
| `action:$notin(allow, tag)` | the action contains none of these |
| `(a $or b) $and c` | grouping |

`$not` binds tightest, then `$and`, then `$or` — the conventional precedence, so
`a $or b $and c` reads as `a $or (b $and c)`. Brackets are there for the times that is not
what you meant.

**Operators carry a `$` for a reason.** A bare `or` is a word that appears in User-Agents
and in paths — `header-order` contains one — and a language where an ordinary search word
silently becomes an operator is a language that lies about what it matched. Typing `or`
searches for the text `or`.

Nothing you can type is an error. The box filters as you type, so half-written input is
the normal state rather than a mistake: an unclosed bracket, a dangling `$or`, a `$in(`
with nothing after it yet all parse to the best available reading of what is there.

An empty set matches nothing rather than everything, for the same reason — `$in()` is a
query somebody is halfway through, and a filter that widens while you are still typing it
is a filter that lies.

A colon with an unknown name in front of it is *not* a field term — a path can contain a
colon and so can a User-Agent — so `foo:bar` searches for the text `foo:bar`.

## Fields

| Field | Also | Matches against |
| --- | --- | --- |
| `path` | `url` | the request path |
| `actor` | `ip` | the actor key, usually the address |
| `ua` | `useragent`, `agent` | the User-Agent string |
| `verdict` | | `confirmed-bot`, `verified-bot`, `suspected-bot`, `human`, `unknown` |
| `class` | `botclass` | `scanner`, `scraper`, `impersonator`, `http-client`, `automation`, … |
| `action` | | what was decided: `allow`, `challenge`, `block`, `tag`, … |
| `outcome` | | the coarse version: `deny`, `mitigate`, `allow`, `pending` |
| `rule` | | the rule id that decided it |
| `detector` | | any detector that produced evidence on this request |
| `identity` | | the named bot, such as `googlebot` |
| `method` | | `GET`, `POST`, … |
| `certain` | | `true` or `false` — whether the verdict rests on proof |
| `bypass` | | why detection was skipped, when it was |
| `id` | `request` | the request id |
| `score` | | 0–100. Takes `>` and `<` as well as `=` |

`score` is the only numeric field. `score:>70`, `score:<20` and `score:60` all work;
everything else matches a substring, case-insensitively.

## Worked examples

```text
actor:203.0.113.4 -path:/health      that address, except its health checks
rule:no-scrapers action:tag          the rule that fired, and what it settled on
score:>70 -certain                   probabilistic traffic close to the line
detector:trap                        everything that touched a trap
class:impersonator verdict:confirmed-bot   proven forgeries
outcome:deny -class:scanner          denials that were not scanners
"GET /api/v2/orders"                 a phrase
```

## The chips

The row of buttons — **All**, **Proven**, **Suspected**, **Human**, **Guard stops**,
**Denied**, **Mitigated**, **Served** — is a separate filter that combines with the query
rather than replacing it. Picking **Denied** and typing `path:/api` gives you denials on
`/api`.

## Saved filters

Anything you can type can be saved by name and recalled from the dropdown beside the box.
Saved filters live in **your browser**, not on the server: they are yours, they do not need
a write endpoint, and clearing site data clears them. They record the query *and* the chip,
because a filter is usually both.

## Hiding traffic

There is no separate exclusion list. `$not` does the job:

```text
$not path:/health                       everything except health checks
path:$notin(/health, /metrics)          except either of two
$not (path:/health $or ua:kube-probe)   except anything matching either
```

This used to be a button that kept its own hidden list in your browser. One mechanism is
better than two, and this one is in the URL like every other narrowing — so a view with
the noise taken out is a link you can send somebody rather than a setting only you have.

Hidden traffic is still assessed, still counted in the metrics, and still acted on. A
filter hides it from *your screen*; it does not stop the engine seeing it.

## Completion

The box completes as you type. Field names come from the parser's own list, so anything it
offers is something the language accepts — and fields whose values are a closed set
(`verdict`, `class`, `action`, `outcome`, `certain`, `method`) complete their values too.
`rule`, `identity` and `path` take anything, so nothing is offered for them: guessing there
would be inventing options rather than completing them.

A token beginning with `$` completes to an operator, and a closed-set field offers `$in(`
and `$notin(` alongside its values — because a field with a fixed set of values is exactly
the field somebody wants two of.

Arrow keys move, Enter or Tab accepts, Escape closes.

## The window

**From** and **To** take absolute instants and either may be left empty, which is what lets
one control answer "from the incident until now", "everything up to when it stopped" and
"between these two moments". They use local time, the same clock the rows show.

## Related

- [The dashboard](dashboard.md) — the screens, and what each one is for
- [Embedding it](embedding.md) — the same dashboard inside your own page
