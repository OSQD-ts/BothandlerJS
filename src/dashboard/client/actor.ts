import { $, clear, el } from "./dom.js";
import { actorActions } from "./actions.js";
import { SECTIONS } from "./boot.js";
import { app } from "./app.js";
import { clockTime, n } from "./format.js";
import { drawBars } from "./bars.js";
import { state } from "./store.js";

/** Wires the panel's own Close button. Called once, and only when the panel exists. */
export function initActor(): void {
  if (!SECTIONS.actors) return;
  $("actor-close").addEventListener("click", closeActor);
}

/** Opens the drill-down above the feed and scrolls it into view. */
export function openActor(key: string): void {
  state.actor = key;
  app.drawNow();
  $("actor-panel").scrollIntoView({ block: "nearest" });
}

function closeActor(): void {
  state.actor = undefined;
  app.drawNow();
}

export function drawActor(): void {
  // The whole panel is removed when the actors section is off, so nothing below here
  // has anything to draw into.
  if (!SECTIONS.actors) return;
  const panel = $("actor-panel");
  if (state.actor === undefined) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $("actor-key").textContent = state.actor;

  const mine = state.rows.filter((row) => row.entry.actor === state.actor).map((row) => row.entry);
  const latest = mine[mine.length - 1];
  const stats = latest?.actorStats;

  const gaps: number[] = [];
  for (let i = 1; i < mine.length; i++) gaps.push((mine[i] as { at: number }).at - (mine[i - 1] as { at: number }).at);
  const meanGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

  const box = $("actor-stats");
  clear(box);
  const rows: Array<[string, string]> = [
    ["In this window", `${n(mine.length)} requests`],
    ["Engine sees", stats !== undefined ? `${n(stats.requests)} requests, ${n(stats.distinctPaths)} distinct paths` : "—"],
    ["Prior confirmations", stats !== undefined ? n(stats.priorConfirmations) : "—"],
    ["Holds clearance", stats !== undefined ? (stats.cleared ? "yes" : "no") : "—"],
    ["First seen", stats !== undefined ? clockTime(stats.firstSeen) : "—"],
    ["Mean gap", gaps.length > 0 ? `${Math.round(meanGap)}ms over ${n(gaps.length)} gaps` : "one request only"],
  ];
  for (const [key, value] of rows) {
    box.appendChild(el("dt", null, key));
    box.appendChild(el("dd", null, value));
  }

  const verdicts = new Map<string, number>();
  const actions = new Map<string, number>();
  for (const entry of mine) {
    verdicts.set(entry.verdict, (verdicts.get(entry.verdict) ?? 0) + 1);
    if (entry.action !== undefined) actions.set(entry.action, (actions.get(entry.action) ?? 0) + 1);
  }
  drawBars($("actor-mix"), [...verdicts, ...actions], "Nothing yet.");

  // The same three operations the Actors screen offers, on the actor already in front
  // of you. Absent entirely without `controls.editRanges`.
  const bar = $("actor-actions");
  clear(bar);
  const buttons = actorActions(state.actor, () => app.drawNow());
  bar.hidden = buttons.length === 0;
  for (const button of buttons) bar.appendChild(button);
}
