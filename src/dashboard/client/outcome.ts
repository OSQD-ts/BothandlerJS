import type { DashboardEntry } from "./types.js";

/**
 * One request has one of four outcomes, and every part of the page agrees on which.
 *
 * Served, mitigated (something happened that a legitimate client can still get past),
 * denied, or pending — assessed, with no decision recorded, which is what `assess()`
 * on its own produces and what a row looks like for the moment between the two events.
 *
 * Pure, and exported on its own, because the table, the left edges, the timeline, the
 * actor mix and the statistics panels all classify the same way. Two of them disagreeing
 * about what a denial is would be a bug nobody could see.
 */
export type Outcome = "allow" | "mitigate" | "deny" | "pending";

const DENY = new Set(["block", "drop", "redirect"]);
const MITIGATE = new Set(["challenge", "rate-limit", "delay"]);

export function outcome(entry: Pick<DashboardEntry, "action">): Outcome {
  return actionKind(entry.action);
}

/** The same classification for a bare action name, which is what the rule editor has. */
export function actionKind(action: string | undefined): Outcome {
  if (action === undefined) return "pending";
  if (DENY.has(action)) return "deny";
  if (MITIGATE.has(action)) return "mitigate";
  return "allow";
}

/** The verdict badge: its class, and the word on it. */
export function verdictBadge(entry: Pick<DashboardEntry, "verdict" | "bypass">): [className: string, label: string] {
  if (entry.verdict === "verified-bot" || entry.verdict === "confirmed-bot") return ["b-proven", entry.verdict];
  if (entry.verdict === "suspected-bot") return ["b-suspected", "suspected-bot"];
  if (entry.verdict === "human") return ["b-human", "human"];
  return ["b-unknown", entry.bypass !== undefined ? `skipped · ${entry.bypass}` : "unknown"];
}

/**
 * How many assessments proved a *bot*.
 *
 * Not `metrics.proven`, which is what the tile used to show. That counter is honestly
 * named for what it holds — assessments resting on at least one piece of proven evidence —
 * and evidence has a direction: a client holding an operator or interaction clearance
 * produces *certain human* evidence, so it lands there too. A dashboard watching nothing
 * but cleared humans therefore read "Proven bots: 100% of traffic", and the same requests
 * were counted again under Unremarkable.
 *
 * The two proven-bot verdicts are the exact answer. Only the proven path can reach them —
 * the probabilistic path produces `suspected-bot`, `human` or `unknown` and nothing else —
 * so this is a rename of the truth rather than an approximation of it.
 */
export function provenBots(verdicts: Record<string, number>): number {
  return (verdicts["confirmed-bot"] ?? 0) + (verdicts["verified-bot"] ?? 0);
}
