import type { DashboardEntry } from "./types.js";

/** A rule as the editor holds it: plain JSON, plus the card's open/closed state. */
export interface EditorRule {
  id: string;
  match: Record<string, unknown>;
  action: string;
  params?: Record<string, unknown>;
  reason?: string;
  /** Editor-only: whether this card is expanded. Stripped before anything is submitted. */
  _open?: boolean;
}

export interface Draft {
  rule: EditorRule;
  /** One line saying what the draft matched on, and why that and not something else. */
  because: string;
}

/**
 * Turns a request you are looking at into a rule you can preview.
 *
 * This is the half of the loop the dashboard was missing. The row detail could already
 * turn a request into a replay line and a corpus case — the offline loop, where a
 * verdict you disagree with becomes a test. The online loop ran the other way and had
 * no help at all: you saw an actor worth acting on, then went and hand-wrote a rule in
 * a different tab, guessing at which field would catch it.
 *
 * Three decisions in here, and all three are about not being clever on somebody's
 * behalf:
 *
 * **The action is always `tag`.** Never `block`, never `challenge`, whatever the
 * request looks like. A drafted rule is a starting point that has not been reviewed by
 * anyone, and the dashboard picking a terminal action for a request that annoyed you is
 * exactly the reflex this library exists to interrupt. The operator picks the action;
 * the guard still checks it afterwards either way.
 *
 * **It matches on the strongest thing the request actually proves**, in a fixed order:
 * a claimed-and-checked identity, else the detectors whose evidence was proven, else
 * the verdict with a score floor. Each of those is a fact about the client. A path
 * would narrow it further and is deliberately left out — the request happens to have
 * one, which is not the same as the rule being about it.
 *
 * **It goes last.** Appending is the only position that cannot change what any
 * existing rule does, because first match wins. A rule that never fires shows up as
 * "never matched" in the preview, which is a better way to learn it is shadowed than
 * discovering it silently took over from something else.
 */
export function draftRule(entry: DashboardEntry, existingIds: readonly string[] = []): Draft {
  const match: Record<string, unknown> = {};
  let because: string;
  let stem: string;

  const proven = entry.evidence.filter((item) => item.certainty === "certain" && item.direction !== "human");
  const detectors = [...new Set((proven.length > 0 ? proven : entry.evidence.filter((item) => item.direction !== "human")).map((item) => item.detector))];

  if (entry.identity !== undefined && entry.identity !== "") {
    match["identity"] = [entry.identity];
    if (entry.certain) match["certain"] = true;
    stem = entry.identity;
    because = entry.certain
      ? `Matched on the identity “${entry.identity}”, and on proof — so a client merely claiming that name does not match.`
      : `Matched on the claimed identity “${entry.identity}”. Nothing has verified it, so this matches anything that says so.`;
  } else if (proven.length > 0) {
    match["detector"] = detectors;
    match["certain"] = true;
    stem = detectors[0] ?? "proven";
    because = `Matched on proof from ${detectors.join(", ")}. Only requests that carry the same proof match.`;
  } else if (detectors.length > 0) {
    match["verdict"] = [entry.verdict];
    match["detector"] = detectors;
    match["minScore"] = Math.max(0, Math.floor(entry.score / 10) * 10);
    stem = detectors[0] ?? entry.verdict;
    because = `Matched on ${entry.verdict} at score ${String(match["minScore"])} or more, from ${detectors.join(", ")}. Every one of those is probabilistic, so the guard will not let this rule deny anybody.`;
  } else {
    match["verdict"] = [entry.verdict];
    stem = entry.verdict;
    because = `Nothing fired on this request, so there is nothing sharper to match on than the verdict itself. Narrow it before you use it.`;
  }

  return {
    rule: {
      id: uniqueId(`from-${slug(stem)}`, existingIds),
      match,
      action: "tag",
      reason: "Drafted from a request on the dashboard.",
      _open: true,
    },
    because,
  };
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "request" : cleaned.slice(0, 40);
}

/** Rule ids name every decision and every log line, so two rules sharing one is a real problem. */
function uniqueId(wanted: string, taken: readonly string[]): string {
  if (!taken.includes(wanted)) return wanted;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${wanted}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${wanted}-${Date.now()}`;
}
