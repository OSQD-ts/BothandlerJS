import { clear, el } from "./dom.js";
import { n } from "./format.js";

/**
 * The pager both tables use.
 *
 * One renderer rather than two, because the feed pages in the browser and the Actors
 * table pages on the server and *neither of those facts belongs in the control*. What it
 * needs to know is where you are and what it should do when you press something.
 *
 * Rendered twice per table, above and below. A table of fifty rows is taller than the
 * window on most screens, and a pager only at the bottom means scrolling to the end to go
 * back to the top of the next page.
 */
export interface PagerModel {
  /** Zero-based. */
  page: number;
  /** What the range reads: `1–50 of 212`. Total omitted where the total is not known. */
  from: number;
  to: number;
  total?: number;
  atStart: boolean;
  atEnd: boolean;
  /** Shown next to the range when the list is being held still. */
  held?: string;
  go: (page: number) => void;
  size?: {
    current: number;
    choices: readonly number[];
    set: (size: number) => void;
  };
}

/** Which way a step goes, in words a screen reader can use. */
interface Step {
  to: number;
  glyph: string;
  label: string;
  disabled: boolean;
}

/**
 * What the last render of each pager was showing.
 *
 * The tables redraw on every arriving request, and rebuilding this control each time
 * replaces the very nodes somebody is reaching for: a select loses its open list mid-choice
 * and a click lands on a node that has just been detached. So it is rebuilt only when what
 * it says changes — the same argument the counter tiles already make for themselves.
 */
const painted = new WeakMap<HTMLElement, string>();

export function renderPager(host: HTMLElement, model: PagerModel, options: { withSize: boolean }): void {
  const signature = JSON.stringify([model.page, model.from, model.to, model.total, model.atStart, model.atEnd, model.held ?? "", options.withSize, model.size?.current]);
  if (painted.get(host) === signature && host.childElementCount > 0) return;
  painted.set(host, signature);
  clear(host);

  const steps: Step[] = [
    { to: model.page - 1, glyph: "‹", label: "Previous page", disabled: model.atStart },
    { to: model.page + 1, glyph: "›", label: "Next page", disabled: model.atEnd },
  ];

  const [previous, next] = steps as [Step, Step];
  host.appendChild(stepButton(previous, model));

  const range = model.total === undefined ? `${n(model.from)}–${n(model.to)}` : `${n(model.from)}–${n(model.to)} of ${n(model.total)}`;
  const where = el("span", "where", range);
  // Announced on change, because the rows themselves are not a live region: somebody
  // paging with the keyboard has to hear that the page moved.
  where.setAttribute("aria-live", "polite");
  host.appendChild(where);

  host.appendChild(stepButton(next, model));

  if (model.held !== undefined) {
    const held = el("span", "held", model.held);
    held.title = "New requests are still arriving and are still counted. They appear when you return to the first page.";
    host.appendChild(held);
  }

  // The size chooser goes on one of the two pagers only. Two of them would be two
  // controls for one setting, which is a thing to keep in sync and a second stop in the
  // tab order that does nothing new.
  if (options.withSize && model.size !== undefined) {
    const size = model.size;
    const label = el("label", "size");
    label.appendChild(document.createTextNode("Per page"));
    const select = document.createElement("select");
    for (const choice of size.choices) {
      const option = document.createElement("option");
      option.value = String(choice);
      option.textContent = String(choice);
      option.selected = choice === size.current;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      const chosen = Number(select.value);
      if (Number.isFinite(chosen) && chosen > 0) size.set(chosen);
    });
    label.appendChild(select);
    host.appendChild(label);
  }
}

function stepButton(step: Step, model: PagerModel): HTMLElement {
  const button = el("button", "step", step.glyph);
  const element = button as HTMLButtonElement;
  element.type = "button";
  element.disabled = step.disabled;
  // The glyph is decoration; the name is the label. A button whose accessible name is
  // "›" tells somebody using a screen reader nothing at all.
  button.setAttribute("aria-label", step.label);
  button.title = step.label;
  button.addEventListener("click", () => model.go(Math.max(0, step.to)));
  return button;
}
