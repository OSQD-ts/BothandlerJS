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
 * (verdict:human $or score:<20) $and $not path:/health
 * "GET /api/v2/orders"                     a phrase, spaces and all
 * ```
 *
 * **Adjacent terms still mean AND**, which is what narrowing means and what every
 * existing query and saved filter relies on. `$and` is available for people who would
 * rather write it than rely on juxtaposition; it parses to the same thing. `$or` binds
 * more loosely than `$and`, and `$not` more tightly than either, so
 * `a $or b $and c` reads as `a $or (b $and c)` — the conventional precedence, and the
 * reason parentheses exist for the times it is not what you meant.
 *
 * Operator names are prefixed with `$` for one reason: a bare `or` is a word that
 * appears in User-Agents and paths, and a language where an ordinary search word
 * silently becomes an operator is a language that lies about what it matched.
 *
 * **Nothing here throws.** It backs a live search box, so half-typed input is the
 * normal state rather than an error: an unclosed parenthesis, a dangling `$or`, a
 * `$in(` with nothing after it all parse to the best reading available.
 *
 * Kept free of the DOM so it can be unit-tested, which is the point: this is the piece
 * of the page most likely to be wrong in a way nobody notices.
 */
export interface Term {
  /** The field named before the colon, already resolved to a canonical name. */
  field: string | undefined;
  value: string;
  negated: boolean;
  /** For numeric fields: how `value` should be compared. */
  compare?: "<" | ">" | "=" | undefined;
  /** For `$in` and `$notin`: the set. `value` holds the first, so a term always has one. */
  values?: readonly string[] | undefined;
}

/**
 * A parsed query.
 *
 * A tree rather than a list, because `$or` cannot be expressed in a list — which is
 * what the flat version of this quietly told people by ignoring it.
 */
export type Filter =
  | { kind: "all" }
  | { kind: "term"; term: Term }
  | { kind: "not"; of: Filter }
  | { kind: "and"; parts: readonly Filter[] }
  | { kind: "or"; parts: readonly Filter[] };

/** Field names, plus the shorthands people type instead. */
const FIELDS: Record<string, string> = {
  path: "path",
  url: "path",
  actor: "actor",
  ip: "actor",
  ua: "userAgent",
  useragent: "userAgent",
  agent: "userAgent",
  verdict: "verdict",
  action: "action",
  rule: "rule",
  detector: "detector",
  identity: "identity",
  method: "method",
  class: "botClass",
  botclass: "botClass",
  id: "requestId",
  request: "requestId",
  bypass: "bypass",
  score: "score",
  outcome: "outcome",
  certain: "certain",
};

const NUMERIC = new Set(["score"]);

/** Every field name the language accepts, including the aliases. For suggestions. */
export const FIELD_NAMES: readonly string[] = Object.keys(FIELDS).sort();

/**
 * Values worth offering for the fields that have a fixed set of them.
 *
 * Only where the set really is closed. `rule`, `identity` and `path` take anything, and
 * offering a guess there would be inventing options rather than completing them.
 */
export const FIELD_VALUES: Readonly<Record<string, readonly string[]>> = {
  verdict: ["confirmed-bot", "verified-bot", "suspected-bot", "human", "unknown"],
  class: ["scanner", "scraper", "impersonator", "automation", "http-client", "declared-bot", "verified-bot", "human", "unknown"],
  botclass: ["scanner", "scraper", "impersonator", "automation", "http-client", "declared-bot", "verified-bot", "human", "unknown"],
  action: ["allow", "tag", "log", "challenge", "rate-limit", "delay", "block", "drop", "redirect"],
  outcome: ["allow", "mitigate", "deny", "pending"],
  certain: ["true", "false"],
  method: ["GET", "POST", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"],
};

/**
 * What to offer for the token the caret is sitting in.
 *
 * Returns the completions and the span they would replace, so the caller can put one in
 * without disturbing the rest of the query. A token that already names a field with a
 * closed value set completes the value; anything else completes the field name.
 */
export function suggestFor(input: string, caret: number): { options: readonly string[]; from: number; to: number } {
  const before = input.slice(0, caret);
  const start = Math.max(before.lastIndexOf(" ") + 1, 0);
  const token = before.slice(start);
  const to = caret;
  const negated = token.startsWith("-") || token.startsWith("!");
  const body = negated ? token.slice(1) : token;
  const colon = body.indexOf(":");

  if (colon === -1) {
    const partial = body.toLowerCase();
    // A token that has begun with `$` can only be an operator, so nothing else is
    // offered for it — and the field names are never prefixed with one.
    if (partial.startsWith("$")) {
      return { options: OPERATORS.filter((name) => name.startsWith(partial)), from: start, to };
    }
    const options = FIELD_NAMES.filter((name) => name.startsWith(partial)).map((name) => `${negated ? token[0] : ""}${name}:`);
    return { options, from: start, to };
  }

  const field = body.slice(0, colon).toLowerCase();
  const values = FIELD_VALUES[field];
  if (values === undefined) return { options: [], from: start, to };
  const partial = body.slice(colon + 1).toLowerCase();
  const prefix = `${negated ? token[0] : ""}${field}:`;
  // The set forms are offered alongside the values, because a field with a closed set
  // is exactly the field somebody wants two of.
  const forms = partial.startsWith("$") ? ["$in(", "$notin("].filter((form) => form.startsWith(partial)).map((form) => `${prefix}${form}`) : [];
  const options = [...forms, ...values.filter((value) => value.toLowerCase().startsWith(partial)).map((value) => `${prefix}${value}`)];
  return { options, from: start, to };
}

/** The operator words the language understands. Offered by the completions too. */
export const OPERATORS: readonly string[] = ["$and", "$or", "$not", "$in", "$notin"];

/** How deep brackets may nest. Far past anything anyone writes, far short of the stack. */
const MAX_GROUP_DEPTH = 32;

type Token = { kind: "word"; text: string } | { kind: "open" } | { kind: "close" } | { kind: "op"; op: "and" | "or" | "not" };

/**
 * Splits the query into words, operators and brackets.
 *
 * Quoted runs stay whole, including their spaces and any bracket inside them. A
 * `field:$in(...)` list is kept as one word rather than being split on its brackets,
 * because its brackets are part of the term and not grouping.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quoted = false;
  let depth = 0;

  const flush = (): void => {
    if (current === "") return;
    const lower = current.toLowerCase();
    if (lower === "$and" || lower === "$or" || lower === "$not") tokens.push({ kind: "op", op: lower.slice(1) as "and" | "or" | "not" });
    else tokens.push({ kind: "word", text: current });
    current = "";
  };

  for (let i = 0; i < input.length; i++) {
    const character = input[i] as string;
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      current += character;
      continue;
    }
    // Inside a `$in(...)` list every character belongs to the word, brackets included.
    if (depth > 0) {
      current += character;
      if (character === "(") depth++;
      else if (character === ")") {
        depth--;
        if (depth === 0) flush();
      }
      continue;
    }
    if (character === "(") {
      // A bracket touching a `$in` / `$notin` opens a set rather than a group.
      if (/\$(in|notin)$/i.test(current)) {
        current += character;
        depth = 1;
        continue;
      }
      flush();
      tokens.push({ kind: "open" });
      continue;
    }
    if (character === ")") {
      flush();
      tokens.push({ kind: "close" });
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return tokens;
}

/** Turns one word into a leaf. Returns `undefined` for a word with nothing in it. */
function toTerm(word: string): Term | undefined {
  const negated = word.startsWith("-") || word.startsWith("!");
  const body = negated ? word.slice(1) : word;
  if (body === "") return undefined;

  const colon = body.indexOf(":");
  const name = colon === -1 ? "" : body.slice(0, colon).toLowerCase();
  const field = FIELDS[name];
  // A colon with an unknown name in front of it is not a field term — a path can
  // contain one, and so can a User-Agent. It falls through to a free term.
  if (colon === -1 || field === undefined) return { field: undefined, value: body.toLowerCase(), negated };

  const rest = body.slice(colon + 1);
  // The closing bracket is stripped separately rather than matched here. Written as one
  // pattern with an optional `\)?` the greedy `.*` swallows the bracket and hands it to
  // the last value, so `$notin(/health, /checkout)` stopped excluding `/checkout`.
  const set = /^\$(in|notin)\(([\s\S]*)$/i.exec(rest);
  if (set !== null) {
    const inside = (set[2] as string).endsWith(")") ? (set[2] as string).slice(0, -1) : (set[2] as string);
    const values = inside
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== "");
    // An empty set matches nothing rather than everything: `$in()` is half-typed, and
    // a filter that widens while somebody is still typing it is a filter that lies.
    const inverted = (set[1] as string).toLowerCase() === "notin";
    return { field, value: values[0] ?? "", negated: negated !== inverted, values };
  }

  let value = rest.toLowerCase();
  let compare: Term["compare"];
  if (NUMERIC.has(field)) {
    compare = value.startsWith(">") ? ">" : value.startsWith("<") ? "<" : "=";
    if (compare !== "=") value = value.slice(1);
  }
  if (value === "") return undefined;
  return { field, value, negated, compare };
}

/**
 * Recursive descent over the tokens, with `$not` binding tightest and `$or` loosest.
 *
 * Tolerant by construction. A dangling operator, an unclosed bracket or a stray close
 * is dropped rather than raised, because every one of them is a query somebody is
 * halfway through typing.
 */
function parseTokens(tokens: readonly Token[]): Filter {
  let at = 0;
  let depth = 0;

  const parseUnary = (): Filter | undefined => {
    const token = tokens[at];
    if (token === undefined) return undefined;
    if (token.kind === "op" && token.op === "not") {
      at++;
      const of = parseUnary();
      return of === undefined ? undefined : { kind: "not", of };
    }
    if (token.kind === "open") {
      at++;
      // Descending on a bracket is recursion over input somebody can paste, and this
      // parser runs on every keystroke *and* on load, because the query lives in the
      // URL. Five thousand nested brackets overflowed the stack and threw a RangeError
      // out of `setSearch` — from a link, that breaks the dashboard for whoever opens
      // it. Past the cap the bracket is simply ignored, which parses the rest at the
      // level above rather than refusing the whole query. No real query nests twice.
      if (depth >= MAX_GROUP_DEPTH) return undefined;
      depth++;
      const inner = parseOr();
      depth--;
      if (tokens[at]?.kind === "close") at++;
      return inner.kind === "all" ? undefined : inner;
    }
    if (token.kind === "close") return undefined;
    if (token.kind === "op") {
      // A leading or doubled `$and` / `$or` connects nothing. Skip it.
      at++;
      return parseUnary();
    }
    at++;
    const term = toTerm(token.text);
    return term === undefined ? undefined : { kind: "term", term };
  };

  const parseAnd = (): Filter => {
    const parts: Filter[] = [];
    while (at < tokens.length) {
      const token = tokens[at];
      if (token === undefined || token.kind === "close") break;
      if (token.kind === "op" && token.op === "or") break;
      if (token.kind === "op" && token.op === "and") {
        at++;
        continue;
      }
      const before = at;
      const part = parseUnary();
      if (part !== undefined) parts.push(part);
      // Nothing consumed means a token this level cannot use; step over it rather than
      // spin. Reachable from a stray bracket.
      if (at === before) at++;
    }
    return parts.length === 0 ? { kind: "all" } : parts.length === 1 ? (parts[0] as Filter) : { kind: "and", parts };
  };

  const parseOr = (): Filter => {
    const parts: Filter[] = [parseAnd()];
    while (tokens[at]?.kind === "op" && (tokens[at] as { op: string }).op === "or") {
      at++;
      parts.push(parseAnd());
    }
    const real = parts.filter((part) => part.kind !== "all");
    if (real.length === 0) return { kind: "all" };
    return real.length === 1 ? (real[0] as Filter) : { kind: "or", parts: real };
  };

  return parseOr();
}

/**
 * The longest query this will read.
 *
 * Parsing is linear in the input, so length is not the cliff depth was — twenty thousand
 * terms parse in about fifty milliseconds. But this runs on every keystroke, and the only
 * bound on what arrives is whatever a browser will carry in a URL, which is not a bound
 * this code should be relying on somebody else to enforce. Eight kilobytes is past any
 * query a person writes and matches the ceiling `createFacts` puts on a request target.
 */
const MAX_QUERY_CHARS = 8192;

/** Parses a query. An empty or unparseable one matches everything. */
export function parseFilter(input: string): Filter {
  const trimmed = input.trim();
  return parseTokens(tokenize(trimmed.length > MAX_QUERY_CHARS ? trimmed.slice(0, MAX_QUERY_CHARS) : trimmed));
}

/** Everything about a request, as one lower-case string. What a free term is matched against. */
export function searchableText(entry: DashboardEntry): string {
  const parts = [
    entry.method,
    entry.path,
    entry.actor,
    entry.userAgent,
    entry.verdict,
    entry.botClass,
    entry.identity ?? "",
    entry.action ?? "",
    entry.rule ?? "",
    entry.requestId,
  ];
  for (const item of entry.evidence) parts.push(item.detector, item.summary);
  return parts.join(" ").toLowerCase();
}

function fieldValue(entry: DashboardEntry, field: string): string {
  switch (field) {
    case "path":
      return entry.path;
    case "actor":
      return entry.actor;
    case "userAgent":
      return entry.userAgent;
    case "verdict":
      return entry.verdict;
    case "action":
      return entry.action ?? "";
    case "rule":
      return entry.rule ?? "";
    case "identity":
      return entry.identity ?? "";
    case "method":
      return entry.method;
    case "botClass":
      return entry.botClass;
    case "requestId":
      return entry.requestId;
    case "bypass":
      return entry.bypass ?? "";
    case "outcome":
      return outcome(entry);
    case "certain":
      return String(entry.certain);
    case "detector":
      return entry.evidence.map((item) => item.detector).join(" ");
    default:
      return "";
  }
}

function matchesTerm(term: Term, entry: DashboardEntry, haystack: string): boolean {
  if (term.field === undefined) return haystack.includes(term.value);
  if (term.values !== undefined) {
    // The set form. Membership is the same substring test one value would get, so
    // `action:$in(block, drop)` reads exactly like two `action:` terms under `$or`.
    if (term.values.length === 0) return false;
    const actual = fieldValue(entry, term.field).toLowerCase();
    return term.values.some((value) => actual.includes(value));
  }
  if (term.field === "score") {
    const wanted = Number(term.value);
    if (Number.isNaN(wanted)) return false;
    if (term.compare === ">") return entry.score > wanted;
    if (term.compare === "<") return entry.score < wanted;
    return entry.score === wanted;
  }
  return fieldValue(entry, term.field).toLowerCase().includes(term.value);
}

/** True when the query is satisfied. An empty one matches everything. */
export function matches(filter: Filter, entry: DashboardEntry, haystack: string): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "term":
      return matchesTerm(filter.term, entry, haystack) !== filter.term.negated;
    case "not":
      return !matches(filter.of, entry, haystack);
    case "and":
      return filter.parts.every((part) => matches(part, entry, haystack));
    case "or":
      return filter.parts.some((part) => matches(part, entry, haystack));
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
