import { $, clear, el } from "./dom.js";
import { actorActions, isConfirming } from "./actions.js";
import { SECTIONS } from "./boot.js";
import { app } from "./app.js";
import { clockStamp, n } from "./format.js";
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
  // Somebody is part-way through naming this actor, or through a confirmation. Rebuilding
  // the panel would take the input and whatever has been typed into it, and the feed
  // redraws on every request that arrives — so on a live dashboard the name box vanished
  // about a second after it opened.
  //
  // The Actors table has held still for this since the editor replaced `prompt()`. This
  // panel offers the identical three controls and was never given the same treatment,
  // which is the whole bug: one of the two places the editor appears was guarded.
  if (isConfirming() && !panel.hidden && $("actor-key").textContent === state.actor) return;

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
    ["First seen", stats !== undefined ? clockStamp(stats.firstSeen) : "—"],
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
  // The name this actor already has, if the registry has been fetched and knows one. A
  // feed entry does not carry it, which is why it is looked up rather than read off the
  // row — the same lookup the Actors table does. Without it this editor always said
  // "Label" and always opened empty, so renaming a client from here quietly discarded
  // the name it already had.
  const known = state.actors.find((actor) => actor.key === state.actor)?.label;
  const buttons = actorActions(state.actor, () => app.drawNow(), known);
  bar.hidden = buttons.length === 0;
  for (const button of buttons) bar.appendChild(button);
}
