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
