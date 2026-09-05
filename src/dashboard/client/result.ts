import { $, clear, el } from "./dom.js";
import { n } from "./format.js";
import type { Preview } from "./types.js";

/** The result box under the editor. One box, whichever of the two forms wrote to it. */
export function showResult(kind: "ok" | "bad" | "warn", build: (box: HTMLElement) => void): void {
  const box = $("policy-result");
  box.hidden = false;
  box.className = `result ${kind}`;
  clear(box);
  build(box);
}

/**
 * What a candidate would have done to the traffic still in the window.
 *
 * `newDenials` is called out on its own because it is the one direction of change that
 * costs somebody their access, and it is easy to miss in a table of counts.
 */
export function renderPreview(preview: Preview, notes: readonly string[] = []): void {
  showResult(preview.newDenials > 0 ? "warn" : "ok", (box) => {
    const head = el("div");
    head.appendChild(el("b", null, `${n(preview.changed)} of ${n(preview.evaluated)} requests would be treated differently.`));
    box.appendChild(head);
    // Whatever led to this preview, kept beside its result. A draft explains what it
    // matched on and why it went last, and that explanation is worth more next to the
    // numbers than it was in the two seconds before they arrived.
    for (const note of notes) box.appendChild(el("div", "ev-meta", note));
    if (preview.newDenials > 0) {
      box.appendChild(el("div", null, `${n(preview.newDenials)} request(s) that are served today would be denied. Read the samples before applying this.`));
    }
    for (const warning of preview.warnings) box.appendChild(el("div", "ev-meta", warning));

    const dead = preview.ruleHits.filter((row) => row.hits === 0 && row.rule !== "default");
    if (dead.length > 0) box.appendChild(el("div", "ev-meta", `Never matched in this window: ${dead.map((row) => row.rule).join(", ")}`));

    if (preview.samples.length > 0) {
      const table = el("table", "diff");
      const head2 = el("tr");
      for (const label of ["Request", "Now", "Would be"]) head2.appendChild(el("th", null, label));
      table.appendChild(head2);
      for (const sample of preview.samples) {
        const row = el("tr");
        const what = el("td");
        what.appendChild(el("div", "mono", sample.path));
        what.appendChild(el("div", "ev-meta", `${sample.verdict} · ${sample.userAgent.slice(0, 48)}`));
        row.appendChild(what);
        const from = el("td", "from");
        from.appendChild(el("div", null, sample.from));
        from.appendChild(el("div", "ev-meta", sample.fromRule));
        row.appendChild(from);
        const kind = sample.to === "block" || sample.to === "drop" || sample.to === "redirect" ? "deny" : sample.to === "allow" ? "allow" : "";
        const to = el("td", `to ${kind}`);
        to.appendChild(el("div", null, sample.to));
        to.appendChild(el("div", "ev-meta", sample.toRule));
        row.appendChild(to);
        table.appendChild(row);
      }
      box.appendChild(table);
    } else if (preview.evaluated === 0) {
      box.appendChild(el("div", "ev-meta", "No traffic in the window to preview against — send some requests first."));
    }
  });
}
