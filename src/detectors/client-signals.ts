import { parseClientSignals } from "../client/index.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";
import type { ClientSignals } from "../client/index.js";

export interface ClientSignalsOptions {
  /**
   * Where to find the signals on the request. Default: `facts.extra.clientSignals`.
   *
   * You are responsible for putting them there — typically by storing what your
   * signal endpoint received against the session and attaching it in the adapter's
   * `enrich` hook. The library does not invent a storage mechanism for you, because
   * where per-session data lives is a decision only your application can make.
   */
  read?: (facts: DetectionContext["facts"]) => unknown;
}

/**
 * Reads signals reported by the page script.
 *
 * The ceiling here is `moderate`, and it is a hard ceiling for a reason worth
 * restating: every one of these values was produced by JavaScript running inside the
 * client, which is the one place an adversary has complete control. A framework that
 * wants `navigator.webdriver` to read `false` sets it to `false`, and everything this
 * detector sees afterwards is whatever that framework decided to say.
 *
 * What it genuinely catches is automation that never bothered to hide — Selenium out
 * of the box, a scripted Chrome someone pointed at your site this afternoon — which
 * is a large share of real bot traffic. What it must never do is convince you that a
 * clean report means a person.
 */
export function clientSignalsDetector(options: ClientSignalsOptions = {}): Detector {
  const read = options.read ?? ((facts: DetectionContext["facts"]) => facts.extra?.["clientSignals"]);

  return {
    id: "client-signals",
    description: "Reads automation signals reported by the browser-side script (client-asserted, and capped at moderate)",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const signals = parseClientSignals(read(ctx.facts));
      if (!signals) return undefined;

      const results: Evidence[] = [];
      const fired = automationFlags(signals);

      if (fired.length > 0) {
        results.push({
          detector: "client-signals",
          summary: `Page script reported automation markers: ${fired.join(", ")}`,
          direction: "bot",
          certainty: "moderate",
          // Several markers at once is a stronger reading than one, but still capped:
          // the whole payload comes from a place the client controls.
          weight: fired.length >= 2 ? 0.5 : 0.35,
          botClass: "automation",
          metadata: { markers: fired },
        });
      }

      if (signals.interacted === true) {
        results.push({
          detector: "client-signals",
          summary: `Page script observed a trusted input event${signals.msToInteraction !== undefined ? ` after ${signals.msToInteraction}ms` : ""}`,
          direction: "human",
          certainty: "moderate",
          weight: 0.45,
          metadata: { msToInteraction: signals.msToInteraction },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}

function automationFlags(signals: ClientSignals): string[] {
  const fired: string[] = [];
  if (signals.webdriver === true) fired.push("navigator.webdriver");
  if (signals.noLanguages === true) fired.push("empty language list");
  if (signals.zeroDimensions === true) fired.push("zero screen dimensions");
  if (signals.inconsistentPlatform === true) fired.push("platform hint disagrees with User-Agent");
  if (signals.automationGlobals !== undefined && signals.automationGlobals.length > 0) {
    fired.push(`automation globals (${signals.automationGlobals.slice(0, 3).join(", ")})`);
  }
  return fired;
}
