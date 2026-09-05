import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";
import type { ChallengeService } from "../challenge/index.js";

/**
 * Reads a clearance token the client already holds.
 *
 * This is the library's only source of *human*-pointing evidence that is not a
 * guess about headers, and it is worth being exact about what each level earns,
 * because overstating any of them would undo the whole design.
 *
 * - **`operator`** is `certain`. Your application told us this is a person — an
 *   authenticated session, a completed purchase, whatever your own bar is. We are
 *   believing you, not deducing anything, which is the same reasoning that makes a
 *   client's self-declaration `certain` in the other direction.
 * - **`interaction`** is `strong`. A trusted input event was observed. Automation
 *   driving a real browser can synthesise something close, so this is very good
 *   evidence and not proof.
 * - **`pow`** is only `moderate`, and this is the number people are most tempted to
 *   inflate. A solved proof of work shows a JavaScript engine ran and CPU was spent.
 *   A headless Chrome does both, happily and at scale. It raises the cost of a scrape
 *   substantially; it says nothing whatsoever about whether a human is present.
 *
 * The token is bound to the actor and signed, so it cannot be lifted from one client
 * and replayed by another under a different actor key.
 */
export function clearanceDetector(service: ChallengeService): Detector {
  return {
    id: "clearance",
    description: "Reads a signed clearance token proving the client previously passed a check",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const claims = service.read(ctx.actor.key, ctx.facts.cookies);
      if (!claims) return undefined;

      const ageMs = ctx.facts.timestamp - claims.iat;

      if (claims.lvl === "operator") {
        return {
          detector: "clearance",
          summary: "Client holds an operator-granted clearance token",
          direction: "human",
          certainty: "certain",
          deterministicBasis:
            "The application issued this clearance itself, on evidence it holds and this library cannot see. It is an assertion by the operator, not an inference from the request, and the token's signature binds it to this actor.",
          metadata: { level: claims.lvl, ageMs },
        };
      }

      if (claims.lvl === "interaction") {
        return {
          detector: "clearance",
          summary: "Client holds a clearance token granted after a trusted input event",
          direction: "human",
          certainty: "strong",
          weight: 0.7,
          metadata: { level: claims.lvl, ageMs },
        };
      }

      return {
        detector: "clearance",
        summary: "Client holds a clearance token granted for a completed proof of work",
        direction: "human",
        certainty: "moderate",
        weight: 0.45,
        metadata: {
          level: claims.lvl,
          ageMs,
          note: "Proof of work demonstrates a JavaScript engine and spent CPU. It does not demonstrate a person.",
        },
      };
    },
  };
}
