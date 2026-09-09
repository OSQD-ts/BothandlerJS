import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface BlendedIdentityOptions {
  /** Distinct security-tool identities from one actor before it is reported. Default 2. */
  scannerIdentities?: number;
  /** Distinct verifiable crawler identities before it is reported. Default 2. */
  crawlerIdentities?: number;
}

/**
 * What a *series* of requests claimed, read against itself.
 *
 * Every identity check in this library reads one request: this User-Agent names this bot,
 * and that claim is either confirmable or it is not. The set of claims an actor has made
 * over time is a different object, and some sets are self-contradictory in a way no single
 * member of them is.
 *
 * Unlike `identity-rotation`, these hold up under the default address-based actor key,
 * which is the whole reason they are on by default and that one is not. A NAT gateway
 * presents many browsers — that is what makes counting User-Agents useless there. It does
 * not present sqlmap *and* nikto, and it does not claim to be Googlebot *and* Bingbot. The
 * innocent explanation for a hundred browsers behind one address is an office; there is no
 * corresponding innocent explanation for these.
 *
 * Three readings, and each is about a combination rather than a claim:
 *
 * - **Several security tools.** One address arriving as two or more named scanners is a
 *   scan, not a coincidence. The tools announce themselves honestly, which is what makes
 *   the *set* readable even though each member is only `declared-bot` on its own.
 * - **Several verifiable crawlers.** At most one of Googlebot, Bingbot and Yandex can be
 *   true of an address, because each publishes a proof tied to addresses it controls.
 *   Claiming two is a forgery whether or not either was checked.
 * - **A crawler that also probes.** An actor that sent a scanner payload and also claimed
 *   to be a search crawler has told you which of the two is the lie.
 */
export function blendedIdentityDetector(options: BlendedIdentityOptions = {}): Detector {
  const scannerFloor = options.scannerIdentities ?? 2;
  const crawlerFloor = options.crawlerIdentities ?? 2;

  return {
    id: "blended-identity",
    description: "Reads the set of identities one actor has claimed across requests for combinations that cannot all be true",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const claimed = ctx.state.claimedIdentities;
      if (claimed.size === 0) return undefined;

      const scanners: string[] = [];
      const crawlers: string[] = [];
      const benignCrawlers: string[] = [];
      for (const [id, what] of claimed) {
        if (what.category === "security") scanners.push(id);
        if (what.verifiable) crawlers.push(id);
        if (what.category === "search" || what.category === "ai" || what.category === "social") benignCrawlers.push(id);
      }

      const results: Evidence[] = [];

      if (scanners.length >= scannerFloor) {
        results.push({
          detector: "blended-identity",
          summary: `One client has arrived as ${scanners.length} different security tools: ${scanners.join(", ")}`,
          direction: "bot",
          certainty: "strong",
          weight: 0.7,
          botClass: "scanner",
          metadata: { identities: scanners },
        });
      }

      if (crawlers.length >= crawlerFloor) {
        results.push({
          detector: "blended-identity",
          summary: `One client has claimed ${crawlers.length} crawler identities that publish address proofs: ${crawlers.join(", ")}`,
          direction: "bot",
          certainty: "strong",
          weight: 0.7,
          botClass: "impersonator",
          // Not `certain`, and the line is worth holding. Each operator publishes a proof
          // tied to addresses it controls, so at most one claim can be true — but a shared
          // egress in front of two genuinely different clients would produce the same set,
          // and this library refuses to deny anybody on an inference.
          metadata: { identities: crawlers },
        });
      }

      if (ctx.state.payloadProbes > 0 && benignCrawlers.length > 0) {
        results.push({
          detector: "blended-identity",
          summary: `Client claims to be ${benignCrawlers.join(", ")} and has sent ${ctx.state.payloadProbes} scanner payload(s)`,
          direction: "bot",
          certainty: "strong",
          weight: 0.75,
          botClass: "impersonator",
          metadata: { identities: benignCrawlers, payloadProbes: ctx.state.payloadProbes },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}
