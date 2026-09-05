import { el } from "./dom.js";
import type { TabName } from "./types.js";

/**
 * The handful of things every module needs to be able to do to the page as a whole.
 *
 * A mutable record filled in by `index.ts` at start-up, rather than each module
 * importing the module that owns `draw`. The feed opens the actor panel, the actor
 * panel drafts a rule into the policy editor, the policy editor switches to its own
 * tab: written as direct imports that is a cycle, and a cycle in a bundle is a
 * half-initialised module waiting to be discovered at run time. One indirection costs
 * a property lookup and makes the shape obvious.
 */
export interface App {
  /** Redraws the active view on the next frame. Coalesced; safe to call per event. */
  draw: () => void;
  /** Redraws immediately, for the cases where a click has to be reflected before the next frame. */
  drawNow: () => void;
  showTab: (tab: TabName, options?: { focus?: boolean; replace?: boolean; push?: boolean }) => void;
  /** Puts the feed's filter state into the URL, so a view can be sent to somebody. */
  syncUrl: () => void;
}

export const app: App = {
  draw: () => {},
  drawNow: () => {},
  showTab: () => {},
  syncUrl: () => {},
};

/**
 * A transient message in the corner.
 *
 * Lives here rather than in the policy editor because the guard form, the feed's
 * exporter and the stream all raise them now, and three copies of a six-line function
 * is how they end up looking different from each other.
 */
export function toast(kind: "ok" | "bad" | "warn", title: string, detail = ""): void {
  const node = el("div", `toast ${kind}`);
  node.appendChild(el("b", null, title));
  if (detail !== "") node.appendChild(el("span", null, detail));
  const host = document.getElementById("toasts");
  if (host === null) return;
  host.appendChild(node);
  setTimeout(() => node.remove(), 6000);
}

/** Hands the viewer a file. Used by the settings export and the feed export. */
export function download(text: string, filename: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = el("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Today, as a filename fragment. Every export the page produces is stamped with it. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
