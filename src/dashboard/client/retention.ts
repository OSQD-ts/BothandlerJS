import { byId, el } from "./dom.js";
import { postJson } from "./api.js";
import { app, toast } from "./app.js";
import { state } from "./store.js";
import { rangeLabel } from "./format.js";
import { refreshWindowCount } from "./window-count.js";

/**
 * How long the server keeps the requests behind the feed.
 *
 * A control that changes the *server*, for everybody looking at it, rather than a
 * preference belonging to this browser — which is why it sits behind the same permission
 * as the policy editor and why it is hidden outright on a dashboard that may not edit.
 * A reader who cannot change it is shown nothing rather than a disabled box: a control
 * that exists only to refuse is worse than no control.
 *
 * The choices are deliberately coarse. This is a memory decision as much as a retention
 * one — every entry held is an address, a User-Agent, a header set and an evidence list —
 * and a free-text box inviting somebody to type "30d" on a busy origin is a way to run a
 * process out of memory from a web page. The server caps it as well; this is the half that
 * stops the question being asked.
 */
const CHOICES: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 15 * 60_000, label: "15 minutes" },
  { ms: 60 * 60_000, label: "1 hour" },
  { ms: 6 * 60 * 60_000, label: "6 hours" },
  { ms: 24 * 60 * 60_000, label: "24 hours" },
  { ms: 3 * 24 * 60 * 60_000, label: "3 days" },
  { ms: 7 * 24 * 60 * 60_000, label: "7 days" },
];

let drawn = "";

/** Reflects the server's current retention, and offers to change it. */
export function drawRetention(): void {
  const host = byId<HTMLElement>("retention");
  const feed = state.snapshot?.feed;
  if (feed === undefined || !feed.editable) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const pick = byId<HTMLSelectElement>("retention-pick");
  // Redrawn only when the answer changed. A select rebuilt on every counters frame closes
  // its own dropdown while somebody is choosing from it.
  const signature = `${feed.retentionMs}:${feed.maxRetentionMs}`;
  if (signature !== drawn) {
    drawn = signature;
    pick.textContent = "";
    const choices = CHOICES.filter((choice) => choice.ms <= feed.maxRetentionMs);
    // A retention configured in code may be a value no dropdown offers. It is listed
    // rather than silently rounded to a neighbour, because rounding it here would change
    // the server's setting the first time somebody touched an unrelated control.
    if (!choices.some((choice) => choice.ms === feed.retentionMs)) {
      choices.push({ ms: feed.retentionMs, label: feed.retentionMs === 0 ? "until evicted" : rangeLabel(feed.retentionMs) });
      choices.sort((a, b) => a.ms - b.ms);
    }
    for (const choice of choices) {
      const option = el("option", null, choice.label) as HTMLOptionElement;
      option.value = String(choice.ms);
      pick.appendChild(option);
    }
    pick.value = String(feed.retentionMs);
    pick.title = `Requests older than this are dropped from the live feed, for everyone looking at it. The counts above outlive them, so the totals stay true. ${state.snapshot?.feed.retained ?? 0} of ${state.snapshot?.feed.capacity ?? 0} entries are held.`;
  }
}

export function initRetention(): void {
  const pick = byId<HTMLSelectElement>("retention-pick");
  pick.addEventListener("change", () => {
    const ms = Number(pick.value);
    if (!Number.isFinite(ms)) return;
    void apply(ms);
  });
}

async function apply(ms: number): Promise<void> {
  const result = await postJson<{ retentionMs: number; capped: boolean }>("/api/retention", { ms });
  if (!result.ok) {
    toast("bad", "Not changed", result.error ?? "");
    // Put the control back to what the server actually has, rather than leaving it
    // showing a value that was refused.
    drawn = "";
    drawRetention();
    return;
  }
  const kept = result.data.retentionMs;
  toast(
    "ok",
    `Keeping ${kept === 0 ? "until evicted" : rangeLabel(kept)}`,
    kept < ms
      ? "Capped: that is the longest this dashboard may ask for. Set `feedTtlMs` in code for anything longer."
      : "Everyone looking at this dashboard sees the same window. Requests already older than it are gone now.",
  );
  // Applied at once rather than on the next frame, so the header's count and the feed
  // stop disagreeing with the promise the control just made.
  //
  // The count especially: shortening the retention drops requests from the window, so the
  // total on screen is wrong the instant this returns. Waiting for the next counters frame
  // leaves a stale number under a control that just said otherwise, which is the most
  // confusing moment available — the reader has just acted and the page appears not to
  // have noticed.
  if (state.snapshot !== undefined) state.snapshot.feed.retentionMs = kept;
  drawn = "";
  await refreshWindowCount({ force: true });
  app.drawNow();
}
