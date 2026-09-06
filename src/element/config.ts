/**
 * The element's decisions, with no document in sight.
 *
 * `src/element/` is excluded from the coverage report for the same reason
 * `src/dashboard/client/` is — it needs a document and a custom-element registry, and a
 * number collected from a runner that cannot execute it would describe the runner. That
 * exclusion carries a second half in the client's case, and it was missing here: the pure
 * modules inside an excluded directory still get unit tests, they are simply not counted.
 * This is that module for the element.
 *
 * Everything below answers a question with an argument rather than by looking at the page:
 * which screens survive a config, what a status code means, where the handler is mounted,
 * whether two configs describe the same thing. It is also where the fiddly parts live —
 * `tabs` and `hide` naming different vocabularies, a screen the server withheld — which is
 * exactly the logic that had bugs in it and no test able to reach them.
 */

import type { DashboardSections } from "../dashboard/sections.js";

export type BotDashboardTabId = "live" | "actors" | "stats" | "policy";

export interface BotDashboardTab {
  id: BotDashboardTabId;
  /** Shown in the tab strip. Defaults to the built-in name. */
  label?: string;
}

/** A panel of your own, rendered beside the built-in ones. */
export interface BotDashboardPanel {
  id: string;
  /** Which screen it appears on. */
  screen: BotDashboardTabId;
  title: string;
  /**
   * Where its rows come from: a URL returning `{ rows: [{ label, value, note? }] }`, or a
   * function returning the same shape.
   *
   * Rendered as text, always — the same rule the rest of the client follows, and for the
   * same reason. Nothing here interprets markup, so a value that happens to contain a tag
   * appears as that tag rather than becoming one.
   */
  source: string | (() => Promise<BotDashboardRows> | BotDashboardRows);
  /** How often to refresh, ms. Omit for once on load. */
  refreshMs?: number;
}

export interface BotDashboardRows {
  rows: ReadonlyArray<{ label: string; value: string | number; note?: string }>;
}

export interface BotDashboardTheme {
  /**
   * Token overrides, by custom property name without the leading dashes:
   * `{ accent: "#7c3aed", surface: "#fff" }`.
   *
   * Applied to the host, so they cascade into the shadow root the same way the built-in
   * tokens do. Every token the stylesheet defines can be replaced; the contrast
   * guarantees the built-in palette was measured against are yours to keep once you do.
   */
  tokens?: Record<string, string>;
  /** Force a scheme instead of following the host page and the OS. */
  scheme?: "light" | "dark";
  /** `compact` tightens the row and panel padding. */
  density?: "comfortable" | "compact";
}

export interface BotDashboardConfig {
  /** Where the dashboard handler is mounted. Also settable as the `src` attribute. */
  src?: string;
  /** Which screens appear, in which order, under which labels. */
  tabs?: readonly BotDashboardTab[];
  /** Panels of your own. */
  panels?: readonly BotDashboardPanel[];
  theme?: BotDashboardTheme;
  /**
   * Hide parts of the page the *server* is still serving.
   *
   * Cosmetic, and worth being clear about: a section switched off here is removed from
   * the screen and stays on the wire. The `sections` option on the handler is the one
   * that stops the data leaving the process, and it is the one to use when the point is
   * that somebody should not have it.
   */
  hide?: DashboardSections;
}

/**
 * The section flag that decides whether each screen exists.
 *
 * Omitting a tab has to be expressed this way rather than by deleting the element: the
 * client builds its tab list from the sections it was booted with and then looks each one
 * up, so a missing element is a crash rather than a smaller strip. Saying it in the boot
 * object means the client removes the screen itself, the way it already does for a
 * section the server switched off.
 */
export const TAB_SECTION: Record<BotDashboardTabId, keyof DashboardSections> = {
  live: "feed",
  actors: "registry",
  stats: "statistics",
  policy: "policy",
};

/** `hide: { policy: true }` means the client's `sections.policy` is false. */
function invert(hide: DashboardSections): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(hide)) if (value === true) out[key] = false;
  return out;
}

/**
 * Which sections the client should be booted with, and what to say about the config.
 *
 * Three inputs settle it, in this order: what the server offered, what `hide` removes, and
 * what `tabs` narrows to. The warnings are returned rather than logged because the reasons
 * a screen goes missing are the interesting part and the caller is the only one that knows
 * whether it has already said them.
 */
export function resolveSections(
  fromServer: Readonly<Record<string, boolean>>,
  config: Pick<BotDashboardConfig, "hide" | "tabs">,
): { sections: Record<string, boolean>; warnings: string[] } {
  const sections: Record<string, boolean> = { ...fromServer };
  const warnings: string[] = [];

  // `tabs` and `hide` do not share a vocabulary — `tabs` names screens (`live`, `actors`,
  // `stats`, `policy`) and `hide` names sections (`feed`, `registry`, `statistics`,
  // `policy`, and the finer-grained ones that are not screens at all). A name from the
  // wrong list is not a type error to anyone writing plain JavaScript, and did nothing
  // whatsoever: `hide: { live: true }` is the natural thing to write after reading about
  // `tabs`, and it left the live feed exactly where it was.
  for (const key of Object.keys(config.hide ?? {})) {
    if (Object.hasOwn(sections, key)) continue;
    const suggestion = TAB_SECTION[key as BotDashboardTabId];
    warnings.push(
      suggestion === undefined
        ? `hide.${key} is not a section this dashboard has, so it did nothing. It has: ${Object.keys(sections).sort().join(", ")}.`
        : `hide.${key} did nothing — "${key}" is a tab name, and \`hide\` takes section names. You want hide.${suggestion}, or leave "${key}" out of \`tabs\`.`,
    );
  }
  for (const [key, value] of Object.entries(invert(config.hide ?? {}))) sections[key] = value;

  // A tab left out of `tabs` is a screen the client should not build at all.
  const wanted = config.tabs;
  if (wanted !== undefined && wanted.length > 0) {
    const keep = new Set(wanted.map((tab) => tab.id));
    for (const id of keep) {
      // Dropped in silence until now, so asking for two screens and being given one looked
      // like the element choosing for itself.
      if (TAB_SECTION[id] === undefined) {
        warnings.push(`tabs lists "${id}", which is not a screen. The screens are: ${Object.keys(TAB_SECTION).join(", ")}.`);
        continue;
      }
      // Asked for, and withheld by the server rather than by anything on this page. The
      // element cannot override it and should not pretend to: `sections` is enforced where
      // the data is, which is the whole point of it. But a developer who lists two screens
      // and is given one deserves to be told which file to go and look in.
      if (fromServer[TAB_SECTION[id]] === false && config.hide?.[TAB_SECTION[id]] !== true) {
        warnings.push(
          `tabs lists "${id}", but this dashboard's server has the "${TAB_SECTION[id]}" section switched off, so that screen does not exist. That is the \`sections\` option on createDashboardHandler, and it is enforced there rather than here.`,
        );
      }
    }
    for (const id of Object.keys(TAB_SECTION) as BotDashboardTabId[]) {
      if (!keep.has(id)) sections[TAB_SECTION[id]] = false;
    }
  }

  return { sections, warnings };
}

/**
 * Where the handler is mounted, from a raw `src`.
 *
 * A trailing slash is dropped, and so are a query string and a fragment — the element
 * appends `/api/bootstrap` to this, so anything after the path cannot survive that
 * concatenation and never could. Left in, `src="/_bots?token=x"` failed with "it answered
 * text/html — is createDashboardHandler mounted at /_bots?token=x?", which sends somebody
 * to check the one thing that was right.
 */
export function parseMount(raw: string): { base: string; warning?: string } {
  const cut = raw.search(/[?#]/);
  if (cut === -1) return { base: raw.replace(/\/$/, "") };
  return {
    base: raw.slice(0, cut).replace(/\/$/, ""),
    warning: `src "${raw}" has a ${raw[cut] === "?" ? "query string" : "fragment"} on it. The element asks for \`<src>/api/bootstrap\`, so only the path can mean anything here; the rest was ignored.`,
  };
}

/**
 * What a refusal from the handler actually means to whoever has to fix it.
 *
 * "it answered 401" is true and useless, and 401 is not an exotic case: the documented
 * setup is a dashboard with `auth` set, embedded in an admin page, and a background fetch
 * cannot put up the sign-in prompt that a browser would show for a navigation. So the
 * dashboard is simply blank with a number on it, and the number does not say that the
 * credentials the operator already has are the answer.
 */
export function explainStatus(status: number, base: string): string {
  if (status === 401) {
    return `it answered 401 Unauthorized. The dashboard has \`auth\` set, and the element fetches in the background, where a browser cannot offer the sign-in prompt it would show for a normal navigation. Open ${base || "the dashboard"} directly and sign in once — the browser then sends those credentials with the element's requests too — or put this page behind the same authentication.`;
  }
  if (status === 403) {
    return `it answered 403 Forbidden, which is this dashboard refusing the caller rather than the password: check \`allowedHosts\` and \`allowedClients\`, and that this page is on the same origin as \`src\`.`;
  }
  return `it answered ${status}`;
}

/**
 * What of a config actually decides the rendered screens: which tabs, and which panels
 * where. Deliberately not the panel `source` functions — a framework rebuilds those
 * closures on every render, and a comparison that counted them would report a change on
 * every render regardless of whether anything meaningful differed.
 */
export function shapeOf(config: BotDashboardConfig): string {
  const tabs = (config.tabs ?? []).map((tab) => tab.id).join(",");
  const panels = (config.panels ?? []).map((panel) => `${panel.id}@${panel.screen}:${panel.title}`).join(",");
  return `${tabs}|${panels}`;
}

/** A panel cell, as text and never as markup, and never longer than a cell should be. */
export function cellText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 200);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value)?.slice(0, 200) ?? "";
  } catch {
    return "";
  }
}
