import { identityShape } from "../probe/marker.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/**
 * What a client does when it is asked to prove something.
 *
 * Every other detector here observes traffic that would have happened anyway, and has
 * to argue backwards from it. This one reads a reaction to a stimulus **we chose**, and
 * that difference is what makes it worth having: we decided when the challenge went
 * out, so a client that changes what it claims to be within seconds of receiving one is
 * responding to it. There was no reason to look at that moment other than that we made
 * it happen.
 *
 * Two reactions are worth reporting, and they mean different things.
 *
 * **Changing identity.** A client challenged as Chrome that returns as curl, or as
 * Googlebot, is trying a different disguise to see whether the door opens. Software
 * does not change what it is; an operator changes it, and the only reason to change it
 * at that moment is the challenge.
 *
 * **Never answering, repeatedly.** A person who abandons one challenge is ordinary — a
 * slow phone, a lost tab, a change of mind. A client asked five times that has never
 * once come back is not abandoning: it is unable or unwilling, and both are facts about
 * software rather than about a person's patience.
 *
 * **Why neither reaches `certain`, and why one is weaker than the other.** Both join
 * two requests, and the join is the weak link. With a marker the join is cryptographic
 * and the two requests provably came from one client. Without one they are tied by
 * address alone, and a busy NAT will eventually put a different person's browser in the
 * seconds after somebody else was challenged — so the same observation is reported a
 * tier lower, because that is genuinely how much less it is worth. Never answering is
 * capped lower still: a person with JavaScript disabled produces it forever, and they
 * are a person.
 */
export interface ChallengeReactionOptions {
  /** How soon after a challenge a change of identity counts as a reaction. Default 60s. */
  windowMs?: number;
  /** Unanswered challenges before that is worth reporting. Default 4. */
  minUnsolved?: number;
}

export function challengeReactionDetector(options: ChallengeReactionOptions = {}): Detector {
  const windowMs = options.windowMs ?? 60_000;
  const minUnsolved = options.minUnsolved ?? 4;

  return {
    id: "challenge-reaction",
    description: "Reads how a client responded to being challenged: a changed identity, or never answering at all",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const found: Evidence[] = [];
      const { at, shape } = ctx.state.lastChallenge;
      const since = at === 0 ? Number.POSITIVE_INFINITY : ctx.facts.timestamp - at;

      // The shape is computed only when there is a recent challenge to compare it with.
      // It is three hashes, which is not free, and on the overwhelming majority of
      // requests there is nothing to compare.
      if (shape !== undefined && since >= 0 && since <= windowMs) {
        const now = ctx.marker?.shape ?? identityShape(ctx.facts, ctx.ua);
        if (now.b !== shape.b) {
          // A marker makes the join cryptographic; without one it is the address, and a
          // busy NAT can produce this from two unrelated people.
          const proven = ctx.marker?.reading.kind === "valid";
          found.push({
            detector: "challenge-reaction",
            summary: proven
              ? `Client changed the browser it claims to be within ${Math.round(since / 1000)}s of being challenged, holding the same marker throughout`
              : `A client at this address changed the browser it claims to be within ${Math.round(since / 1000)}s of being challenged`,
            direction: "bot",
            certainty: proven ? "strong" : "moderate",
            botClass: "impersonator",
            // One cause with `identity-drift`: this client changed what it claims to be.
            // Both fire together whenever a challenge is what prompted the change.
            family: "identity-change",
          });
        }
      }

      if (ctx.state.unsolvedChallenges >= minUnsolved) {
        found.push({
          detector: "challenge-reaction",
          summary: `Challenged ${ctx.state.unsolvedChallenges} times and has never returned a solution`,
          direction: "bot",
          certainty: "moderate",
          botClass: "unknown",
        });
      }

      return found.length > 0 ? found : undefined;
    },
  };
}
