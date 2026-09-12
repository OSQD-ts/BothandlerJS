import { evaluate, parseFilter, termMatchesNumber, termMatchesText } from "./client/query.js";
import type { Filter, Term, Vocabulary } from "./client/query.js";

/**
 * The feed's query language, read over actors instead of requests.
 *
 * The same operators, quoting, negation and precedence — `$and`, `$or`, `$not`, `$in`,
 * `$notin`, a leading `-`, brackets — because they are the language, and somebody who has
 * learned it on the feed should not have to learn a second dialect one tab away. Only the
 * vocabulary differs, since the two screens are about different things: a request has a
 * path and a verdict, an actor has a request count and a cadence.
 *
 * Shared by the page and the server, and that is the point of it being here rather than in
 * `client/`. The Actors table is paged on the server, so filtering it on the page would
 * filter one page of it — narrowing "the busiest fifty" rather than "everybody", which is
 * the opposite of what a filter is for. The server filters the whole registry and pages
 * what is left, and it does so with this exact code, so the two lists cannot drift apart.
 */

/** What an actor filter can name. */
const ACTOR_FIELDS: Record<string, string> = {
  actor: "key",
  ip: "key",
  key: "key",
  label: "label",
  name: "label",
  requests: "requests",
  rate: "recentRate",
  permin: "recentRate",
  paths: "distinctPaths",
  agents: "distinctUserAgents",
  confirmations: "priorConfirmations",
  proven: "priorConfirmations",
  unsolved: "unsolvedChallenges",
  cadence: "cadenceCv",
  cleared: "cleared",
};

/** Compared as numbers, so `requests:>100` means what it looks like. */
const ACTOR_NUMERIC: ReadonlySet<string> = new Set(["requests", "recentRate", "distinctPaths", "distinctUserAgents", "priorConfirmations", "unsolvedChallenges", "cadenceCv"]);

/** An address is an identifier: `actor:1.2.3.4` must not also match `1.2.3.45`. */
const ACTOR_IDENTIFIERS: ReadonlySet<string> = new Set(["key"]);

export const ACTOR_VOCABULARY: Vocabulary = { fields: ACTOR_FIELDS, numeric: ACTOR_NUMERIC };

/** Everything an actor filter can be asked about. A registry summary satisfies this. */
export interface FilterableActor {
  key: string;
  label?: string | undefined;
  requests: number;
  recentRate?: number | undefined;
  distinctPaths: number;
  distinctUserAgents?: number | undefined;
  priorConfirmations: number;
  unsolvedChallenges: number;
  cadenceCv?: number | undefined;
  cleared: boolean;
}

/** Parses an actor query. Like the feed's, an empty or unreadable one matches everything. */
export function parseActorFilter(input: string): Filter {
  return parseFilter(input, ACTOR_VOCABULARY);
}

function numberOf(actor: FilterableActor, field: string): number | undefined {
  switch (field) {
    case "requests":
      return actor.requests;
    case "recentRate":
      return actor.recentRate;
    case "distinctPaths":
      return actor.distinctPaths;
    case "distinctUserAgents":
      return actor.distinctUserAgents;
    case "priorConfirmations":
      return actor.priorConfirmations;
    case "unsolvedChallenges":
      return actor.unsolvedChallenges;
    case "cadenceCv":
      return actor.cadenceCv;
    default:
      return undefined;
  }
}

function textOf(actor: FilterableActor, field: string): string {
  if (field === "key") return actor.key.toLowerCase();
  if (field === "label") return (actor.label ?? "").toLowerCase();
  // `cleared:yes` and `cleared:no` both read, because "is it cleared" is the question and
  // `-cleared:yes` is a clumsier way to ask the other half of it.
  if (field === "cleared") return actor.cleared ? "yes true" : "no false";
  return "";
}

function matchesTerm(term: Term, actor: FilterableActor): boolean {
  // A bare word searches what somebody would recognise the actor by, which is its key and
  // the name they gave it — not its numbers, where a stray `3` would match half the table.
  if (term.field === undefined) return termMatchesText(term, `${actor.key} ${actor.label ?? ""}`.toLowerCase(), false);
  if (ACTOR_NUMERIC.has(term.field)) return termMatchesNumber(term, numberOf(actor, term.field));
  return termMatchesText(term, textOf(actor, term.field), ACTOR_IDENTIFIERS.has(term.field));
}

/** True when the actor satisfies the query. */
export function matchesActor(filter: Filter, actor: FilterableActor): boolean {
  return evaluate(filter, (term) => matchesTerm(term, actor));
}
