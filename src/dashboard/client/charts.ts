import { $, clear, css, el, svgEl, svgText } from "./dom.js";
import { n, pct, ms, rangeLabel, windowLabel } from "./format.js";
import { oldestAt, state } from "./store.js";
import { outcome } from "./outcome.js";

const BUCKETS = 60;
const LATENCY_BOUNDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100];
const SCORE_BOUNDS = 10;

interface Bucket {
  at: number;
  served: number;
  mitigated: number;
  denied: number;
  total: number;
}

/** Puts a tooltip beside the pointer without letting it hang off the panel. */
function positionTip(tip: HTMLElement, host: HTMLElement, clientX: number, boxLeft: number): void {
  tip.style.opacity = "1";
  tip.style.left = `${Math.min(host.clientWidth - 150, Math.max(4, clientX - boxLeft - 60))}px`;
  tip.style.top = "14px";
}

function tipRow(label: string, value: string, colour?: string): HTMLElement {
  const line = el("div", "r");
  const left = el("em");
  if (colour !== undefined) {
    const swatch = el("span", "swatch");
    swatch.style.background = colour;
    left.appendChild(swatch);
  }
  left.appendChild(document.createTextNode(label));
  line.appendChild(left);
  line.appendChild(el("b", null, value));
  return line;
}

function timeline(): Bucket[] {
  const bucketMs = state.rangeMs / BUCKETS;
  const now = Date.now();
  const start = now - state.rangeMs;
  const buckets: Bucket[] = [];
  for (let i = 0; i < BUCKETS; i++) buckets.push({ at: start + i * bucketMs, served: 0, mitigated: 0, denied: 0, total: 0 });
  for (const { entry } of state.rows) {
    const index = Math.floor((entry.at - start) / bucketMs);
    if (index < 0 || index >= BUCKETS) continue;
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    bucket.total++;
    const out = outcome(entry);
    if (out === "deny") bucket.denied++;
    else if (out === "mitigate") bucket.mitigated++;
    else bucket.served++;
  }
  return buckets;
}

/**
 * Stacked bars, two series, plus a marker row for denials.
 *
 * Two series rather than three because served/mitigated/denied as three fills would
 * need a third hue that survives colour-vision simulation beside these two, and none
 * does; a denial is a status rather than a series, so it gets a status marker and a
 * label instead.
 */
export function drawTraffic(): void {
  const host = $("traffic-chart");
  const svg = $("traffic");
  const width = Math.max(320, host.clientWidth - 30);
  const height = 190;
  const padBottom = 26;
  const markerRow = 8;
  const plot = height - padBottom - markerRow;
  const buckets = timeline();
  const now = Date.now();
  const start = now - state.rangeMs;
  let peak = 1;
  for (const bucket of buckets) if (bucket.total > peak) peak = bucket.total;
  // Round the ceiling up to an even number so the mid gridline lands on a whole
  // request rather than on 1.5 rendered as "2".
  const max = Math.max(2, Math.ceil(peak / 2) * 2);

  clear(svg);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("height", String(height));

  const s1 = css("--s1");
  const s2 = css("--s2");
  const crit = css("--crit");
  const grid = css("--grid");
  const muted = css("--muted");
  const step = width / BUCKETS;
  const barWidth = Math.max(2, step - 2);

  // Three gridlines: enough to read a magnitude, few enough to stay recessive.
  for (const fraction of [0, 0.5, 1]) {
    const y = markerRow + plot - fraction * plot;
    svg.appendChild(svgEl("line", { x1: 0, x2: width, y1: y, y2: y, stroke: grid, "stroke-width": 1 }));
    if (fraction > 0) svg.appendChild(svgText({ x: 2, y: y - 3, fill: muted, "font-size": 10 }, Math.round(max * fraction)));
  }

  buckets.forEach((bucket, index) => {
    const x = index * step + 1;
    const servedHeight = (bucket.served / max) * plot;
    const mitigatedHeight = (bucket.mitigated / max) * plot;
    let y = markerRow + plot;

    if (servedHeight > 0) {
      y -= servedHeight;
      svg.appendChild(svgEl("rect", { x, y, width: barWidth, height: servedHeight, fill: s1, rx: 2 }));
    }
    if (mitigatedHeight > 0) {
      // A 2px gap between stacked segments, so the boundary is a surface line rather
      // than two colours meeting.
      y -= mitigatedHeight + (servedHeight > 0 ? 2 : 0);
      svg.appendChild(svgEl("rect", { x, y: Math.max(markerRow, y), width: barWidth, height: mitigatedHeight, fill: s2, rx: 2 }));
    }
    if (bucket.denied > 0) svg.appendChild(svgEl("rect", { x, y: 0, width: barWidth, height: 5, fill: crit, rx: 2 }));
  });

  svg.appendChild(svgEl("line", { x1: 0, x2: width, y1: markerRow + plot, y2: markerRow + plot, stroke: css("--line"), "stroke-width": 1 }));
  const span = rangeLabel(state.rangeMs);
  const labels: Array<[number, string]> = [
    [0, `${span} ago`],
    [BUCKETS / 2, rangeLabel(state.rangeMs / 2)],
    [BUCKETS - 1, "now"],
  ];
  for (const [position, text] of labels) {
    svg.appendChild(svgText({ x: Math.min(width - 26, Math.max(0, position * step)), y: height - 8, fill: muted, "font-size": 10 }, text));
  }

  // Runtime changes, on the same axis as the traffic they changed.
  //
  // A preview says "44 of 151 requests would be treated differently", which is a
  // prediction. Nothing on the page used to tell you whether it held: the moment of the
  // change left no trace, so the traffic before and after it were the same undifferentiated
  // line. A marker per change turns the chart into the answer.
  const changes = (state.snapshot?.changes ?? []).filter((change) => change.at >= start && change.at <= now);
  const markColour = css("--proven-text");
  for (const change of changes) {
    const x = ((change.at - start) / state.rangeMs) * width;
    svg.appendChild(svgEl("line", { x1: x, x2: x, y1: 0, y2: markerRow + plot, stroke: markColour, "stroke-width": 1.5, "stroke-dasharray": "3 2", opacity: 0.85 }));
    const dot = svgEl("circle", { cx: x, cy: 3, r: 3, fill: markColour });
    const title = svgEl("title");
    title.textContent = `${new Date(change.at).toLocaleTimeString()} · ${change.kind}: ${change.summary}${change.by === undefined ? "" : ` (by ${change.by})`}`;
    dot.appendChild(title);
    svg.appendChild(dot);
  }

  const hover = svgEl("rect", { x: 0, y: 0, width: 0, height: markerRow + plot, fill: css("--ink"), opacity: 0.06 });
  svg.appendChild(hover);

  const tip = $("traffic-tip");
  host.onmousemove = (event: MouseEvent): void => {
    const box = svg.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * BUCKETS);
    const bucket = buckets[index];
    if (bucket === undefined) {
      tip.style.opacity = "0";
      hover.setAttribute("width", "0");
      return;
    }
    hover.setAttribute("x", String(index * step));
    hover.setAttribute("width", String(step));
    clear(tip);
    tip.appendChild(el("div", "t", `${new Date(bucket.at).toLocaleTimeString()} · ${Math.round(state.rangeMs / BUCKETS / 1000)}s`));
    tip.appendChild(tipRow("Served", n(bucket.served), s1));
    tip.appendChild(tipRow("Mitigated", n(bucket.mitigated), s2));
    tip.appendChild(tipRow("Denied", n(bucket.denied), crit));
    positionTip(tip, host, event.clientX, box.left);
  };
  host.onmouseleave = (): void => {
    tip.style.opacity = "0";
    hover.setAttribute("width", "0");
  };

  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  $("traffic-window").textContent = `last ${rangeLabel(state.rangeMs)}`;

  // What the chart says, in words.
  //
  // `role="img"` with a label told a screen reader that a picture is here and its name.
  // It did not tell anybody what is *in* it, so every number on this screen was
  // unreachable to a reader who cannot see the bars. The chart is the presentation; this
  // is the data, and it is the same data.
  const served = buckets.reduce((sum, bucket) => sum + bucket.served, 0);
  const mitigated = buckets.reduce((sum, bucket) => sum + bucket.mitigated, 0);
  const denied = buckets.reduce((sum, bucket) => sum + bucket.denied, 0);
  const busiest = buckets.reduce((best, bucket) => (bucket.total > best.total ? bucket : best), buckets[0] ?? { at: now, total: 0, served: 0, mitigated: 0, denied: 0 });
  $("traffic-alt").textContent =
    `Traffic over the last ${rangeLabel(state.rangeMs)}: ${n(total)} requests — ${n(served)} served, ${n(mitigated)} mitigated, ${n(denied)} denied. ` +
    (total === 0
      ? "No traffic in this range."
      : `Busiest ${Math.round(state.rangeMs / BUCKETS / 1000)}-second interval: ${n(busiest.total)} requests at ${new Date(busiest.at).toLocaleTimeString()}.`) +
    (changes.length === 0 ? "" : ` ${n(changes.length)} runtime change${changes.length === 1 ? "" : "s"} in this range: ${changes.map((change) => `${change.kind}, ${change.summary}`).join("; ")}.`);

  const legend = $("traffic-legend");
  clear(legend);
  legend.appendChild(el("span", null, `${n(total)} requests in the last ${rangeLabel(state.rangeMs)} ·`));
  // The ring is finite. Saying so beats drawing an empty half-hour that only means the
  // feed forgot it.
  const oldest = oldestAt();
  if (oldest !== undefined && Date.now() - oldest < state.rangeMs * 0.9) {
    legend.appendChild(el("span", null, `window holds ${rangeLabel(Date.now() - oldest)} ·`));
  }
  for (const [label, colour] of [
    ["Served", s1],
    ["Mitigated — challenged, limited or delayed", s2],
    ["Denied", crit],
  ] as Array<[string, string]>) {
    const item = el("span");
    const swatch = el("span", "swatch");
    swatch.style.background = colour;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  }
  if (changes.length > 0) {
    const item = el("span");
    item.appendChild(el("span", "mark"));
    item.appendChild(document.createTextNode(`${n(changes.length)} runtime change${changes.length === 1 ? "" : "s"} — hover a marker`));
    legend.appendChild(item);
  }
}

/** Cumulative bucket counts to per-bucket ones. Prometheus wants the first; a histogram needs the second. */
function differences(cumulative: readonly number[]): number[] {
  const counts: number[] = [];
  for (let i = 0; i < cumulative.length; i++) counts.push((cumulative[i] ?? 0) - (i > 0 ? (cumulative[i - 1] ?? 0) : 0));
  return counts;
}

/**
 * The score distribution: how close ordinary traffic runs to the line.
 *
 * Two populations, and the panel now says which one it is drawing rather than leaving
 * the reader to assume. **Since start** comes from the same counters as the Prometheus
 * endpoint, so it covers the whole run and agrees with whatever your alerting says.
 * **This window** counts the few hundred requests the page is still holding, which is
 * the right answer to "what is happening right now" and the wrong answer to "where
 * should the threshold be" — and it was the only answer available before, sitting
 * beside panels counting since start under an identical grey subtitle.
 *
 * Proven requests are excluded from both rather than piled into the last bucket: their
 * score is 100 by definition and plays no part in any decision.
 */
export function drawScores(): void {
  const host = $("score-chart");
  const svg = $("scores");
  clear(svg);

  const metrics = state.snapshot?.metrics;
  const fromRun = state.scoreScope === "run" && metrics !== undefined;

  let buckets: number[];
  let scored: number;
  let proven: number;
  if (fromRun && metrics !== undefined) {
    buckets = differences(metrics.scores.buckets);
    scored = metrics.scores.count;
    proven = metrics.proven;
  } else {
    buckets = new Array<number>(SCORE_BOUNDS).fill(0);
    scored = 0;
    proven = 0;
    for (const { entry } of state.rows) {
      if (entry.bypass !== undefined) continue;
      if (entry.certain) {
        proven++;
        continue;
      }
      const index = Math.min(SCORE_BOUNDS - 1, Math.floor(entry.score / 10));
      buckets[index] = (buckets[index] ?? 0) + 1;
      scored++;
    }
  }

  const width = Math.max(280, host.clientWidth - 30);
  const height = 190;
  const padBottom = 30;
  const plot = height - padBottom;
  let max = 1;
  for (const value of buckets) if (value > max) max = value;

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("height", String(height));

  const fill = css("--s1");
  const muted = css("--muted");
  const grid = css("--grid");
  const crit = css("--crit");
  svg.appendChild(svgEl("line", { x1: 0, x2: width, y1: plot, y2: plot, stroke: grid, "stroke-width": 1 }));

  const step = width / SCORE_BOUNDS;
  buckets.forEach((value, index) => {
    const barHeight = (value / max) * (plot - 8);
    // Capped and centred: ten buckets across a wide panel would otherwise be ten slabs,
    // and a histogram reads better as marks than as a wall.
    const barWidth = Math.max(2, Math.min(step - 6, 56));
    if (barHeight > 0) {
      svg.appendChild(svgEl("rect", { x: index * step + (step - barWidth) / 2, y: plot - barHeight, width: barWidth, height: barHeight, fill, rx: 3 }));
    }
    svg.appendChild(svgText({ x: index * step + 1, y: height - 14, fill: muted, "font-size": 9.5 }, index * 10));
  });

  const threshold = state.snapshot?.policy.suspectThreshold ?? 60;
  const x = (threshold / 100) * width;
  svg.appendChild(svgEl("line", { x1: x, x2: x, y1: 0, y2: plot, stroke: crit, "stroke-width": 2, "stroke-dasharray": "4 3" }));
  svg.appendChild(svgText({ x: Math.min(width - 92, x + 5), y: 11, fill: crit, "font-size": 10 }, `suspect at ${threshold}`));
  svg.appendChild(svgText({ x: 0, y: height - 2, fill: muted, "font-size": 10 }, "score (probabilistic requests only)"));

  const tip = $("score-tip");
  host.onmousemove = (event: MouseEvent): void => {
    const box = svg.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * SCORE_BOUNDS);
    const value = buckets[index];
    if (value === undefined) {
      tip.style.opacity = "0";
      return;
    }
    clear(tip);
    tip.appendChild(el("div", "t", `score ${index * 10}–${index * 10 + 9}`));
    tip.appendChild(tipRow("requests", n(value)));
    tip.appendChild(tipRow("share", pct(value, scored)));
    positionTip(tip, host, event.clientX, box.left);
  };
  host.onmouseleave = (): void => {
    tip.style.opacity = "0";
  };

  let over = 0;
  for (let bucket = 0; bucket < SCORE_BOUNDS; bucket++) if (bucket * 10 >= threshold) over += buckets[bucket] ?? 0;

  const legend = $("score-legend");
  clear(legend);
  legend.appendChild(el("span", null, `${n(scored)} scored · ${n(over)} at or over the threshold · ${n(proven)} proven, which carry no score`));

  $("score-alt").textContent =
    `Distribution of probabilistic scores ${fromRun ? "since start" : "in the retained window"}, with the suspect threshold at ${threshold}. ` +
    `${n(scored)} scored requests, ${n(over)} at or over the threshold, ${n(proven)} proven and therefore unscored. ` +
    (scored === 0 ? "Nothing scored yet." : `By ten-point band: ${buckets.map((value, index) => `${index * 10}–${index * 10 + 9}: ${n(value)}`).join(", ")}.`);
  $("score-window").textContent = fromRun ? "since start" : windowLabel(state.rows.length, oldestAt(), Date.now());
  if (state.scoreScope === "run" && metrics === undefined) {
    legend.appendChild(el("span", null, "· counters are off on this handler, so this is the retained window"));
  }
}

export function drawLatency(): void {
  const host = $("latency-chart");
  const svg = $("latency");
  clear(svg);
  const metrics = state.snapshot?.metrics;
  if (metrics === undefined || metrics.duration.count === 0) {
    $("latency-summary").textContent = "No assessments yet.";
    $("latency-alt").textContent = "Assessment latency: no assessments yet.";
    svg.setAttribute("viewBox", "0 0 100 40");
    svg.setAttribute("height", "40");
    svg.appendChild(svgText({ x: 0, y: 20, fill: css("--muted"), "font-size": 11 }, "No assessments yet."));
    return;
  }

  const cumulative = metrics.duration.buckets;
  const counts = differences(cumulative);

  const width = Math.max(280, host.clientWidth - 30);
  const height = 190;
  const padBottom = 30;
  const plot = height - padBottom;
  let max = 1;
  for (const value of counts) if (value > max) max = value;

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("height", String(height));

  const fill = css("--s1");
  const muted = css("--muted");
  const grid = css("--grid");
  svg.appendChild(svgEl("line", { x1: 0, x2: width, y1: plot, y2: plot, stroke: grid, "stroke-width": 1 }));

  const step = width / counts.length;
  counts.forEach((value, index) => {
    const barHeight = (value / max) * (plot - 6);
    if (barHeight > 0) {
      svg.appendChild(svgEl("rect", { x: index * step + 1, y: plot - barHeight, width: Math.max(2, step - 3), height: barHeight, fill, rx: 3 }));
    }
    if (index % 2 === 0) {
      svg.appendChild(svgText({ x: index * step + 1, y: height - 14, fill: muted, "font-size": 9.5 }, index < LATENCY_BOUNDS.length ? String(LATENCY_BOUNDS[index]) : "more"));
    }
  });
  svg.appendChild(svgText({ x: 0, y: height - 2, fill: muted, "font-size": 10 }, "milliseconds (upper bound of each bucket)"));

  const tip = $("latency-tip");
  host.onmousemove = (event: MouseEvent): void => {
    const box = svg.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * counts.length);
    const value = counts[index];
    if (value === undefined) {
      tip.style.opacity = "0";
      return;
    }
    clear(tip);
    tip.appendChild(el("div", "t", index < LATENCY_BOUNDS.length ? `≤ ${LATENCY_BOUNDS[index]}ms` : "over 100ms"));
    tip.appendChild(tipRow("requests", n(value)));
    tip.appendChild(tipRow("share", pct(value, metrics.duration.count)));
    positionTip(tip, host, event.clientX, box.left);
  };
  host.onmouseleave = (): void => {
    tip.style.opacity = "0";
  };

  const mean = metrics.duration.totalMs / metrics.duration.count;
  const p95 = percentile(cumulative, metrics.duration.count, 0.95);
  $("latency-summary").textContent = `Time spent in detection, per request · mean ${ms(mean)} · p95 ${ms(p95)} · max ${ms(metrics.duration.maxMs)}`;
  $("latency-alt").textContent =
    `Assessment latency since start over ${n(metrics.duration.count)} requests: mean ${ms(mean)}, 95th percentile ${ms(p95)}, maximum ${ms(metrics.duration.maxMs)}. ` +
    `By bucket: ${counts.map((value, index) => `${index < LATENCY_BOUNDS.length ? `up to ${LATENCY_BOUNDS[index]}ms` : "over 100ms"}: ${n(value)}`).join(", ")}.`;
}

/** Bucket-boundary percentile. Coarse by construction — it is a histogram, not a series. */
function percentile(cumulative: readonly number[], count: number, fraction: number): number {
  const target = count * fraction;
  const last = LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1] ?? 100;
  for (let i = 0; i < cumulative.length; i++) {
    if ((cumulative[i] ?? 0) >= target) return i < LATENCY_BOUNDS.length ? (LATENCY_BOUNDS[i] ?? last) : last;
  }
  return last;
}
