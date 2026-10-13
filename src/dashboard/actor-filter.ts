import { compile, defineVocabulary } from "@osqd/jql";
import { parseText } from "@osqd/jql/text";

/**
 * The feed's query language, read over actors instead of requests.
 *
 * The same operators, quoting, negation and precedence — `$and`, `$or`, `$not`, `$in`,
 * `$notin`, a leading `-`, brackets — because they are the language, and somebody who has
 * learned it on the feed should not have to learn a second dialect one tab away. Both are
 * JQL's text syntax (`@osqd/jql/text`); only the vocabulary differs, since the two screens
 * are about different things: a request has a path and a verdict, an actor has a request
 * count and a cadence.
 *
 * Shared by the page and the server, and that is the point of it being here rather than in
 * `client/`. The Actors table is paged on the server, so filtering it on the page would
 * filter one page of it — narrowing "the busiest fifty" rather than "everybody", which is
 * the opposite of what a filter is for. The server filters the whole registry and pages
 * what is left, and it does so with this exact code, so the two lists cannot drift apart.
 */

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

/**
 * What an actor filter can name.
 *
 * The key is a `word`, matched a whole component at a time, for the reason the feed's
 * `actor:` is: `actor:1.2.3.4` must not also match `1.2.3.45`, or excluding one client
 * excludes its neighbours. The counts are numbers, so `requests:>100` means what it looks
 * like — and a count this actor does not have yet (a cadence needs a few gaps to measure)
 * answers no comparison at all rather than being read as zero. `cleared` is a boolean, so
 * `cleared:yes` and `cleared:no` both read, because "is it cleared" is the question and
 * `-cleared:yes` is a clumsier way to ask the other half of it.
 *
 * A bare word searches what somebody would recognise an actor by — its key and the name
 * they gave it — and not its numbers, where a stray `3` would match half the table.
 *
 * Not exported: the vocabulary's type is JQL's, and this module is compiled into the
 * package's declarations, which should not name a package the library does not depend on
 * at run time.
 */
const ACTOR_VOCABULARY = defineVocabulary<FilterableActor>()({
  fields: {
    actor: { path: "key", aliases: ["ip", "key"], kind: "word" },
    label: { aliases: ["name"] },
    requests: { kind: "number" },
    rate: { path: "recentRate", aliases: ["permin"], kind: "number" },
    paths: { path: "distinctPaths", kind: "number" },
    agents: { path: "distinctUserAgents", kind: "number" },
    confirmations: { path: "priorConfirmations", aliases: ["proven"], kind: "number" },
    unsolved: { path: "unsolvedChallenges", kind: "number" },
    cadence: { path: "cadenceCv", kind: "number" },
    cleared: { kind: "boolean", values: ["yes", "no"] },
  },
  text: ["actor", "label"],
});

/**
 * Compiles an actor query into a predicate. Like the feed's, an empty one matches
 * everything, and nothing typed is an error.
 *
 * The `catch` is belt and braces, as it is for the feed: `parseText` never throws and its
 * output is built to compile, but this runs on the server for a query string anybody can
 * send, and a filter that could not be built matches nothing rather than everything — or
 * rather than answering 500.
 */
export function compileActorFilter(input: string): (actor: FilterableActor) => boolean {
  try {
    return compile<FilterableActor>(parseText(input, { vocabulary: ACTOR_VOCABULARY }), { vocabulary: ACTOR_VOCABULARY });
  } catch {
    return () => false;
  }
}
