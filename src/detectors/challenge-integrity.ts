import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/**
 * Answers to challenges that were well-formed and still wrong.
 *
 * The verification endpoint is deliberately not assessed — a client that has just been
 * challenged must not be challenged again for trying to answer — so nothing else in the
 * pipeline ever sees what happens there. Two of those outcomes say something about the
 * client rather than about the request, and this is where they surface.
 *
 * **A solution submitted twice.** A challenge nonce is random, single-use and signed, so
 * a second valid solution for one is not a coincidence: it is the same answer sent
 * again, or one answer being shared out. The threshold is not one, because a flaky
 * network and a retried POST produce exactly one.
 *
 * **A solution returned faster than the puzzle allows.** The work is measured on this
 * server between issuing and receiving, so no client clock is involved, and the floor is
 * set at a SHA-256 rate no browser has ever reached. Coming in under it means the answer
 * was not computed by the script we sent.
 */
export interface ChallengeIntegrityOptions {
  /** Replayed solutions before this says anything. Default 3. */
  minReplays?: number;
  /** Implausibly fast solutions before this says anything. Default 1. */
  minImplausible?: number;
}

export function challengeIntegrityDetector(options: ChallengeIntegrityOptions = {}): Detector {
  const minReplays = options.minReplays ?? 3;
  const minImplausible = options.minImplausible ?? 1;

  return {
    id: "challenge-integrity",
    description: "Reports solutions that were replayed, or returned faster than the proof of work allows",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const { replays, implausible } = ctx.state.challengeAnomalies;
      const found: Evidence[] = [];

      if (replays >= minReplays) {
        found.push({
          detector: "challenge-integrity",
          summary: `Submitted ${replays} solutions for challenges that had already been solved`,
          direction: "bot",
          certainty: "moderate",
          botClass: "unknown",
        });
      }

      if (implausible >= minImplausible) {
        found.push({
          detector: "challenge-integrity",
          summary:
            implausible > 1
              ? `Returned ${implausible} solutions faster than the proof of work can be computed in a browser`
              : "Returned a solution faster than the proof of work can be computed in a browser",
          direction: "bot",
          certainty: "moderate",
          botClass: "automation",
        });
      }

      return found.length > 0 ? found : undefined;
    },
  };
}
