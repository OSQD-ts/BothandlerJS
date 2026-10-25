import { clear, el } from "./dom.js";
import { n } from "./format.js";

/** A horizontal bar list, sorted by value, capped at what a panel can show without scrolling. */
export function drawBars(target: HTMLElement, rows: Iterable<[string, number]>, emptyText: string, link?: (label: string) => HTMLElement): void {
  clear(target);
  const filtered = [...rows].filter(([, value]) => value > 0);
  if (filtered.length === 0) {
    target.appendChild(el("div", "note", emptyText));
    return;
  }
  filtered.sort((a, b) => b[1] - a[1]);
  const max = filtered[0]?.[1] ?? 1;
  for (const [label, value] of filtered.slice(0, 14)) {
    // The UI kit's ranked bar list: the container carries `oq-bars`, each row is label,
    // track and count. The bar's length is a custom property set through the CSSOM, which
    // the page's CSP allows where a style attribute would not be.
    const bar = el("div", "bar oq-bars__item");
    const name = el("span", "oq-bars__label");
    // A link when the label names something the Reference screen explains.
    if (link === undefined) name.textContent = label;
    else name.appendChild(link(label));
    name.title = label;
    const track = el("span", "oq-bars__track");
    const fill = el("span", "oq-bars__bar");
    fill.style.setProperty("--value", `${Math.max(2, Math.round((value / max) * 100))}%`);
    track.appendChild(fill);
    bar.appendChild(name);
    bar.appendChild(track);
    bar.appendChild(el("span", "oq-bars__value tnum", n(value)));
    target.appendChild(bar);
  }
}

/** A record of counters as bar rows. */
export function pairs(record: Record<string, number> | undefined): Array<[string, number]> {
  return Object.entries(record ?? {});
}
