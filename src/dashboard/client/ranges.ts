import { $, clear, el, holdsTextEntry } from "./dom.js";
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

export function drawRanges(): void {
  if (!SECTIONS.ranges) return;
  const body = $("ranges-body");
  // Not while somebody is typing an address into it. See `holdsTextEntry`.
  if (holdsTextEntry(body)) return;
  clear(body);

  $("ranges-mode").textContent = BOOT.allowActing ? "editable" : "read-only";
  $("ranges-note").textContent = BOOT.allowActing
    ? "An address on the allowlist is not judged leniently — it is not judged at all. Detection does not run on it, no evidence is produced, and no rule sees it."
    : "These come from the code that constructed the handler. Enable controls.editRanges to add an address from here.";

  if (sets.length === 0) {
    body.appendChild(el("div", "note", "No range sets are configured. Add an address to the allowlist and one appears."));
  }

  for (const set of sets) {
    const block = el("div", "rangeset");
    const heading = el("h3");
    heading.appendChild(document.createTextNode(set.name));
    heading.appendChild(el("span", null, `${n(set.size)} entr${set.size === 1 ? "y" : "ies"}`));
    block.appendChild(heading);

    const list = el("div", "cidrs");
    for (const entry of set.entries) {
      const chip = el("span", BOOT.allowActing ? "cidr" : "cidr readonly");
      chip.appendChild(document.createTextNode(entry));
      if (BOOT.allowActing) {
        const remove = el("button", null, "×");
        remove.title = `Remove ${entry} from ${set.name}`;
        remove.setAttribute("aria-label", `Remove ${entry} from ${set.name}`);
        remove.addEventListener("click", () => void update(set.name, { remove: [entry] }));
        chip.appendChild(remove);
      }
      list.appendChild(chip);
    }
    if (set.entries.length === 0) list.appendChild(el("span", "hint", "empty"));
    block.appendChild(list);
    body.appendChild(block);
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
