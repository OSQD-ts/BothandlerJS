import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface IpIntelligenceOptions {
  /** Weight for a datacenter-range match. Default 0.3 (`moderate`). */
  datacenterWeight?: number;
}

/**
 * What do we know about where this request came from?
 *
 * Two range sets are consulted, and they are treated very differently.
 *
 * **`denylist`** is `certain`, and the justification is not technical. You configured
 * it. The library is not inferring anything; it is carrying out an instruction you
 * gave about addresses you have decided about. Certainty here means "this is a
 * decision, not a guess" — and it means a bad entry in your denylist blocks real
 * people, which is exactly why the range is required to be explicit rather than
 * inherited from a feed by default.
 *
 * **`datacenter`** is `moderate` and always will be. Hosting-provider address space
 * is where scrapers live, and it is *also* where every consumer VPN, every corporate
 * egress gateway, every Tor exit, every privacy relay like iCloud Private Relay, and
 * a growing share of mobile traffic lives. Treating "came from AWS" as proof of
 * automation blocks a meaningful slice of ordinary users, disproportionately the
 * privacy-conscious ones. As corroboration alongside a header failure it is
 * genuinely useful; alone it is close to worthless.
 *
 * No range data ships with this library. Address-to-operator mappings go stale
 * within weeks, and a stale mapping is a false positive with a long half-life —
 * supply your own, from a source you refresh and can audit.
 */
export function ipIntelligenceDetector(options: IpIntelligenceOptions = {}): Detector {
  const datacenterWeight = options.datacenterWeight ?? 0.3;

  return {
    id: "ip-intelligence",
    description: "Matches the client address against operator-supplied denylist and datacenter ranges",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const results: Evidence[] = [];

      const denied = ctx.ranges.get("denylist")?.match(ctx.facts.ip);
      if (denied !== undefined) {
        results.push({
          detector: "ip-intelligence",
          summary: `Client address is inside the configured denylist range ${denied}`,
          direction: "bot",
          certainty: "certain",
          botClass: "unknown",
          deterministicBasis: `The operator of this service configured ${denied} as denied. This is not an inference about the client's behaviour — it is the execution of an explicit local policy decision.`,
          metadata: { range: denied, list: "denylist" },
        });
      }

      const datacenter = ctx.ranges.get("datacenter")?.match(ctx.facts.ip);
      if (datacenter !== undefined) {
        results.push({
          detector: "ip-intelligence",
          summary: `Client address is inside a known datacenter range (${datacenter})`,
          direction: "bot",
          certainty: "moderate",
          weight: datacenterWeight,
          botClass: "unknown",
          metadata: { range: datacenter, list: "datacenter" },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}
