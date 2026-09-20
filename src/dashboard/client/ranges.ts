import { $, clear, el, holdsTextEntry, rootNode } from "./dom.js";
import { BOOT, SECTIONS } from "./boot.js";
import { getJson, postJson } from "./api.js";
import { n } from "./format.js";
import { toast } from "./app.js";

/**
 * The range sets, and what is in them.
 *
 * The Guard panel used to report these as `allowlist (3)` — a count, which tells you
 * that something is exempt without telling you what. These are the lists that decide
 * which traffic is never assessed and which crawler ranges are believed, so "what is
 * actually in it" is the whole question.
 *
 * Editing is behind `controls.editRanges`, and the allowlist carries a warning wherever
 * it appears: an address on it is not judged leniently, it is not judged at all.
 */
interface RangeSet {
  name: string;
  size: number;
  entries: string[];
}

interface RangesBody {
  ranges: RangeSet[];
  editable: boolean;
}

let sets: RangeSet[] = [];

export async function loadRanges(): Promise<void> {
  if (!SECTIONS.ranges) return;
  try {
    const body = await getJson<RangesBody>("/api/ranges");
    sets = body.ranges;
    drawRanges();
  } catch {
    /* the panel simply stays as it was */
  }
}

/** A set this size or smaller opens by default; a larger one starts folded to a line. */
const OPEN_UP_TO = 12;
/** Most chips drawn for one set at once. The filter reaches the rest. */
const MAX_CHIPS = 400;

// Kept by set name across redraws. The panel is rebuilt on every frame the Policy screen
// draws, and a set somebody opened, filtered or scrolled halfway down must not snap back.
const openSets = new Map<string, boolean>();
const filters = new Map<string, string>();
const scrolls = new Map<string, number>();

function chip(set: RangeSet, entry: string): HTMLElement {
  const node = el("span", BOOT.allowActing ? "cidr" : "cidr readonly");
  node.title = entry;
  node.appendChild(el("span", "cidr-text", entry));
  if (BOOT.allowActing) {
    const remove = el("button", null, "×");
    remove.title = `Remove ${entry} from ${set.name}`;
    remove.setAttribute("aria-label", `Remove ${entry} from ${set.name}`);
    remove.addEventListener("click", () => void update(set.name, { remove: [entry] }));
    node.appendChild(remove);
  }
  return node;
}

function fillChips(grid: HTMLElement, status: HTMLElement, set: RangeSet, query: string): void {
  clear(grid);
  const needle = query.trim().toLowerCase();
  const matching = needle === "" ? set.entries : set.entries.filter((entry) => entry.toLowerCase().includes(needle));
  for (const entry of matching.slice(0, MAX_CHIPS)) grid.appendChild(chip(set, entry));
  if (set.entries.length === 0) grid.appendChild(el("span", "hint", "empty"));

  let said = "";
  if (matching.length > MAX_CHIPS) said = `Showing ${n(MAX_CHIPS)} of ${n(matching.length)}${needle === "" ? "" : " matches"}. Filter to narrow it down.`;
  else if (needle !== "") said = matching.length === 0 ? "Nothing in this set matches." : `${n(matching.length)} of ${n(set.entries.length)} match.`;
  status.textContent = said;
  status.hidden = said === "";
  grid.hidden = matching.length === 0 && set.entries.length > 0;
}

/** "212 IPv4 · 38 IPv6", which is the first thing worth knowing about a list too long to read. */
function families(entries: readonly string[]): string {
  const v6 = entries.filter((entry) => entry.includes(":")).length;
  const v4 = entries.length - v6;
  return [v4 > 0 ? `${n(v4)} IPv4` : "", v6 > 0 ? `${n(v6)} IPv6` : ""].filter(Boolean).join(" · ");
}

export function drawRanges(): void {
  if (!SECTIONS.ranges) return;
  const body = $("ranges-body");
  // Not while somebody is typing an address into it. See `holdsTextEntry`.
  if (holdsTextEntry(body)) return;

  for (const grid of Array.from(body.querySelectorAll<HTMLElement>(".cidrs[data-set]"))) scrolls.set(grid.dataset["set"] ?? "", grid.scrollTop);
  const active = (rootNode() as Document | ShadowRoot).activeElement as HTMLElement | null;
  const focusKey = active !== null && body.contains(active) ? active.dataset["focusKey"] : undefined;
  clear(body);

  $("ranges-mode").textContent = BOOT.allowActing ? "editable" : "read-only";
  $("ranges-note").textContent = BOOT.allowActing
    ? "An address on the allowlist is not judged leniently — it is not judged at all. Detection does not run on it, no evidence is produced, and no rule sees it."
    : "These come from the code that constructed the handler. Enable controls.editRanges to add an address from here.";

  if (sets.length === 0) {
    body.appendChild(el("div", "note", "No range sets are configured. Add an address to the allowlist and one appears."));
  }

  for (const set of sets) {
    const long = set.entries.length > OPEN_UP_TO;
    const open = openSets.get(set.name) ?? !long;
    const block = el("div", `rangeset${open ? " open" : ""}`);

    const heading = el("h3");
    const toggle = el("button", "rs-toggle");
    toggle.type = "button";
    toggle.dataset["focusKey"] = `toggle:${set.name}`;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.appendChild(el("span", "chev", open ? "▾" : "▸"));
    toggle.appendChild(el("span", "rs-name", set.name));
    toggle.appendChild(el("span", "rs-count", `${n(set.size)} entr${set.size === 1 ? "y" : "ies"}`));
    toggle.addEventListener("click", () => {
      openSets.set(set.name, !open);
      drawRanges();
    });
    heading.appendChild(toggle);
    const split = families(set.entries);
    if (split !== "") heading.appendChild(el("span", "rs-split", split));
    block.appendChild(heading);

    if (!open) {
      // Folded, a set still says what is in it — the first few, and how many more.
      if (set.entries.length > 0) {
        const more = set.size - Math.min(3, set.entries.length);
        block.appendChild(el("div", "rs-preview", `${set.entries.slice(0, 3).join(", ")}${more > 0 ? `, and ${n(more)} more` : ""}`));
      }
      body.appendChild(block);
      continue;
    }

    const panel = el("div", "rs-body");
    const grid = el("div", long ? "cidrs long" : "cidrs");
    grid.dataset["set"] = set.name;
    const status = el("div", "hint rs-status");
    if (long) {
      // Its own scroller, so one set of three hundred crawler ranges cannot push the rest of
      // the panel off the screen — and reachable from the keyboard when it holds no buttons.
      grid.setAttribute("role", "group");
      grid.setAttribute("aria-label", `Entries in ${set.name}`);
      grid.tabIndex = BOOT.allowActing ? -1 : 0;
      const filter = el("input", "mono-input rs-filter");
      filter.type = "search";
      filter.value = filters.get(set.name) ?? "";
      filter.placeholder = `Filter ${n(set.entries.length)} entries`;
      filter.setAttribute("aria-label", `Filter ${set.name}`);
      filter.autocomplete = "off";
      filter.spellcheck = false;
      filter.addEventListener("input", () => {
        filters.set(set.name, filter.value);
        grid.scrollTop = 0;
        fillChips(grid, status, set, filter.value);
      });
      panel.appendChild(filter);
    }
    panel.appendChild(grid);
    panel.appendChild(status);
    fillChips(grid, status, set, long ? (filters.get(set.name) ?? "") : "");
    block.appendChild(panel);
    body.appendChild(block);
    grid.scrollTop = scrolls.get(set.name) ?? 0;
  }

  if (focusKey !== undefined) {
    for (const node of Array.from(body.querySelectorAll<HTMLElement>("[data-focus-key]"))) if (node.dataset["focusKey"] === focusKey) node.focus();
  }

  if (!BOOT.allowActing) return;

  const form = el("div", "rangeset");
  const row = el("div", "field-row");
  const name = el("input", "mono-input");
  name.type = "text";
  name.value = "allowlist";
  name.setAttribute("aria-label", "Range set");
  name.style.maxWidth = "150px";
  const value = el("input", "mono-input");
  value.type = "text";
  value.placeholder = "203.0.113.0/24";
  value.setAttribute("aria-label", "Address or CIDR to add");
  const add = el("button", null, "Add");
  const submit = (): void => {
    const entry = value.value.trim();
    if (entry === "") return;
    value.value = "";
    void update(name.value.trim(), { add: [entry] });
  };
  add.addEventListener("click", submit);
  value.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  row.appendChild(name);
  row.appendChild(value);
  row.appendChild(add);
  form.appendChild(row);
  body.appendChild(form);
}

async function update(name: string, change: { add?: string[]; remove?: string[] }): Promise<void> {
  const result = await postJson<{ entries?: string[]; error?: string }>("/api/ranges", { name, ...change });
  if (!result.ok) {
    toast("bad", "Ranges unchanged", result.error ?? "");
    return;
  }
  toast(name === "allowlist" && change.add !== undefined ? "warn" : "ok", `“${name}” updated`, `${n(result.data.entries?.length ?? 0)} entr${result.data.entries?.length === 1 ? "y" : "ies"} now.`);
  await loadRanges();
}
