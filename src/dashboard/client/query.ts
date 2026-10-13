import { compile, defineVocabulary } from "@osqd/jql";
import { parseText } from "@osqd/jql/text";
import type { Vocabulary } from "@osqd/jql";
import { outcome } from "./outcome.js";
import type { DashboardEntry } from "./types.js";

/**
 * The feed's search.
 *
 * It used to be one `indexOf` over every field of a request joined into a string,
 * which answers "does this word appear anywhere" and nothing else. That is the wrong
 * question in the two cases somebody actually reaches for the box: an address that
 * also appears inside a User-Agent, and a path that is a prefix of ten others.
 *
 * So terms name a field, and combine:
 *
 * ```text
 * actor:203.0.113.4 -path:/health          that address, except its health checks
 * verdict:human $or verdict:unknown        either verdict
 * $not path:/health                        the same as -path:/health, spelled out
 * action:$in(block, drop)                  one of a set
 * action:$notin(allow, tag)                none of a set
 * score:>=70   score:10..20                comparisons, and a range
 * has:rule    -has:rule                    decided, or still pending
 * (verdict:human $or score:<20) $and $not path:/health
 * "GET /api/v2/orders"                     a phrase, spaces and all
 * ```
 *
 * **The language is JQL's text syntax** (`@osqd/jql/text`), not a dialect of it. This file
 * used to hold its own tokenizer, parser and matcher; the syntax moved to JQL so that every
 * project in the family filters the same way, and what is left here is the one thing only
 * this project can say — what a request's fields are called and where each one lives. The
 * text is parsed into a JQL document and the engine runs that, so there is no second
 * matcher here to drift from the first.
 *
 * What the text syntax promises, it promises for this box too: adjacent terms mean AND,
 * `$not` binds tighter than `$and`, which binds tighter than `$or`, operators carry a `$`
 * because a bare `or` is a word that appears in User-Agents, and nothing anybody types is
 * an error — half-typed input is the normal state of a live search box. See
 * `docs/operations/filters.md` for the whole of it as an operator reads it.
 *
 * Kept free of the DOM so it can be unit-tested, which is the point: this is the piece
 * of the page most likely to be wrong in a way nobody notices.
 */

/**
 * The name an operator gave an actor, looked up when the filter runs.
 *
 * A function rather than a map handed over once, because names are given after the fact —
 * to requests already in the feed — and a lookup at match time is what makes a name reach
 * them. Reading a copy taken when the vocabulary was built would find only the names that
 * existed then.
 */
export type LabelOf = (actor: string) => string | undefined;

/**
 * Values worth completing, for the fields that have a fixed set of them.
 *
 * Only where the set really is closed. `rule`, `identity` and `path` take anything, and
 * offering a guess there would be inventing options rather than completing them.
 */
const VERDICT_VALUES = ["confirmed-bot", "verified-bot", "suspected-bot", "human", "unknown"];
const CLASS_VALUES = ["scanner", "scraper", "impersonator", "automation", "http-client", "declared-bot", "verified-bot", "human", "unknown"];
const ACTION_VALUES = ["allow", "tag", "log", "challenge", "rate-limit", "delay", "block", "drop", "redirect"];
const OUTCOME_VALUES = ["allow", "mitigate", "deny", "pending"];
const METHOD_VALUES = ["GET", "POST", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"];

/**
 * What the feed's filter can name, and where each name finds its value.
 *
 * How a field reads what is typed after its colon is its `kind`:
 *
 * - **Most fields are `text`** — contains the value, ignoring case — which is right for
 *   them: `path:/api` is a prefix search people rely on, a User-Agent is prose, and
 *   `verdict:bot` finding all three kinds of bot is a question worth being able to ask.
 * - **`actor` and `id` are `word`**, matched a whole component at a time. Matched as a
 *   substring, `actor:1.2.3.4` also caught `1.2.3.40` to `1.2.3.49` and `11.2.3.4`, so
 *   excluding one client with `$notin` silently removed a handful of others that happened
 *   to share its digits, and `$in` quietly let them in. A prefix that stops on a separator
 *   (`203.0.113`) still finds the whole network, and a tail (`113.5`) still finds its
 *   address.
 * - **`method` and `outcome` are `exact`.** Both are short closed sets where a substring is
 *   never what was meant: `method:p` is not a way anybody asks for POST, PUT and PATCH.
 * - **`score` is a number**, so `score:>70` compares rather than looking for the digits.
 * - **`certain` is a boolean**, and takes `yes`/`no` as well as `true`/`false`.
 *
 * Five fields are computed rather than stored, and each is a `get` the engine calls when
 * the filter runs:
 *
 * - `actor` answers to the name an operator gave the client as well as to its key, because
 *   a client somebody has named is a client they will go on to search for by that name.
 * - `outcome` is derived from the action and never kept anywhere, so it can never disagree
 *   with the colour the row is drawn in.
 * - `detector` and `evidence` read the evidence list: every detector that found something,
 *   and — for `evidence` — what each one said, so a bare word reaches the summaries the way
 *   it always has.
 * - `line` is the request line as the feed prints it, `GET /api/v2/orders`. It exists for
 *   one reason: the search used to be a single string with the method and the path side by
 *   side, so a quoted `"GET /api/v2/orders"` found that request, and the docs have always
 *   said it would. A search that looks in one field at a time would find it in neither.
 *
 * A bare word searches `text` — what somebody would recognise a request by. Not `score`,
 * `outcome` or `bypass`, which the joined string never held either: a stray `7` matching
 * every score with a seven in it would be noise, not search.
 */
export function entryVocabulary(labelOf: LabelOf = () => undefined) {
  return defineVocabulary<DashboardEntry>()({
    fields: {
      line: { get: (entry) => `${entry.method} ${entry.path}` },
      path: { aliases: ["url"] },
      actor: {
        aliases: ["ip"],
        kind: "word",
        get: (entry) => {
          const label = labelOf(entry.actor);
          return label === undefined ? entry.actor : [entry.actor, label];
        },
      },
      ua: { path: "userAgent", aliases: ["useragent", "agent"] },
      verdict: { values: VERDICT_VALUES },
      class: { path: "botClass", aliases: ["botclass"], values: CLASS_VALUES },
      action: { values: ACTION_VALUES },
      outcome: { kind: "exact", get: outcome, values: OUTCOME_VALUES },
      rule: {},
      detector: { get: (entry) => entry.evidence.map((item) => item.detector) },
      evidence: { get: (entry) => entry.evidence.flatMap((item) => [item.detector, item.summary]) },
      identity: {},
      method: { kind: "exact", values: METHOD_VALUES },
      certain: { kind: "boolean", values: ["true", "false"] },
      bypass: {},
      id: { path: "requestId", aliases: ["request"], kind: "word" },
      score: { kind: "number" },
    },
    text: ["line", "actor", "ua", "verdict", "class", "identity", "action", "rule", "id", "evidence"],
  });
}

/**
 * The feed's vocabulary with no names given. What the completions read, since they only
 * need the field names and their values; the feed itself builds one that can see the names.
 */
export const ENTRY_VOCABULARY = entryVocabulary();

/**
 * Parses a filter and compiles it into a predicate. An empty one matches everything.
 *
 * `parseText` never throws, and what it returns is built to compile. The `catch` is here
 * anyway because of where this runs: on every keystroke, and on load, from whatever query a
 * shared link carried — and a throw out of that breaks the dashboard for whoever opens the
 * link. If it ever did happen, matching nothing is the answer that does not lie: a filter
 * that quietly matched everything would show somebody traffic they had asked not to see.
 */
export function compileSearch<T>(input: string, vocabulary: Vocabulary<T, object>): (item: T) => boolean {
  try {
    return compile<T>(parseText(input, { vocabulary }), { vocabulary });
  } catch {
    return () => false;
  }
}

/** The named filter buttons, which are a second, independent narrowing. */
export type FilterName = "all" | "proven" | "suspected" | "human" | "guard" | "deny" | "mitigate" | "allow";

export function matchesFilter(filter: FilterName, entry: DashboardEntry): boolean {
  switch (filter) {
    case "proven":
      return entry.certain;
    case "suspected":
      return entry.verdict === "suspected-bot";
    case "human":
      return entry.verdict === "human";
    case "guard":
      return entry.downgradedFrom !== undefined;
    case "deny":
      return outcome(entry) === "deny";
    case "mitigate":
      return outcome(entry) === "mitigate";
    case "allow":
      return outcome(entry) === "allow";
    default:
      return true;
  }
}
