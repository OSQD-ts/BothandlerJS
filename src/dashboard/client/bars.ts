import { clear, el } from "./dom.js";
import { n } from "./format.js";

/** A horizontal bar list, sorted by value, capped at what a panel can show without scrolling. */
export function drawBars(target: HTMLElement, rows: Iterable<[string, number]>, emptyText: string): void {
  clear(target);
  const filtered = [...rows].filter(([, value]) => value > 0);
  if (filtered.length === 0) {
    target.appendChild(el("div", "note", emptyText));
    return;
  }
  filtered.sort((a, b) => b[1] - a[1]);
  const max = filtered[0]?.[1] ?? 1;
  for (const [label, value] of filtered.slice(0, 14)) {
    const bar = el("div", "bar");
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = `${Math.max(2, Math.round((value / max) * 100))}%`;
    track.appendChild(fill);
    track.appendChild(el("div", "lbl", label));
    bar.appendChild(track);
    bar.appendChild(el("div", "v tnum", n(value)));
    target.appendChild(bar);
  }
}

/** A record of counters as bar rows. */
export function pairs(record: Record<string, number> | undefined): Array<[string, number]> {
  return Object.entries(record ?? {});
}
