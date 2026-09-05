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
 * So terms can name a field, and can be negated:
 *
 * ```text
 * actor:203.0.113.4 -path:/health      that address, except its health checks
 * rule:no-scrapers action:tag          the rule that fired, and what it settled on
 * score:>70 -certain                   probabilistic traffic close to the line
 * "GET /api/v2/orders"                 a phrase, spaces and all
 * ```
 *
 * Every term must match — this is an `AND`, because that is what narrowing means and
 * a filter box that quietly `OR`s is a filter box that lies. Anything that does not
 * parse as a field term is matched against the whole request, so a plain word still
 * behaves exactly as it did.
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
}

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

/** Splits on whitespace, keeping double-quoted runs together. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of input) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

export function parseQuery(input: string): Term[] {
  const terms: Term[] = [];
  for (const token of tokenize(input.trim())) {
    const negated = token.startsWith("-") || token.startsWith("!");
    const body = negated ? token.slice(1) : token;
    if (body === "") continue;

    const colon = body.indexOf(":");
    const name = colon === -1 ? "" : body.slice(0, colon).toLowerCase();
    const field = FIELDS[name];
    // A colon with an unknown name in front of it is not a field term — a path can
    // contain one, and so can a User-Agent. It falls through to a free term.
    if (colon === -1 || field === undefined) {
      terms.push({ field: undefined, value: body.toLowerCase(), negated });
      continue;
    }

    let value = body.slice(colon + 1).toLowerCase();
    let compare: Term["compare"];
    if (NUMERIC.has(field)) {
      compare = value.startsWith(">") ? ">" : value.startsWith("<") ? "<" : "=";
      if (compare !== "=") value = value.slice(1);
    }
    if (value === "") continue;
    terms.push({ field, value, negated, compare });
  }
  return terms;
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
  if (term.field === "score") {
    const wanted = Number(term.value);
    if (Number.isNaN(wanted)) return false;
    if (term.compare === ">") return entry.score > wanted;
    if (term.compare === "<") return entry.score < wanted;
    return entry.score === wanted;
  }
  return fieldValue(entry, term.field).toLowerCase().includes(term.value);
}

/** True when every term is satisfied. An empty query matches everything. */
export function matchesQuery(terms: readonly Term[], entry: DashboardEntry, haystack: string): boolean {
  for (const term of terms) {
    if (matchesTerm(term, entry, haystack) === term.negated) return false;
  }
  return true;
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
