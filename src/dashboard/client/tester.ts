import { $, byId, clear, el } from "./dom.js";
import { SECTIONS } from "./boot.js";
import { ms } from "./format.js";
import { outcome, verdictBadge } from "./outcome.js";
import { postJson } from "./api.js";
import { toast } from "./app.js";
import type { DashboardEntry } from "./types.js";

/**
 * The request tester.
 *
 * The page's answer to the question that arrives by ticket rather than by traffic: *why
 * is this client being challenged?* Until now the only way to find out was to wait for
 * them to come back and hope you were watching, or to reproduce their request by hand
 * against the live site — which puts it in the feed, in the counters and in that
 * actor's history, so investigating a complaint changed the thing being investigated.
 *
 * This runs a **dry run** on the server: every detector runs and the decision is real,
 * including the guard, but nothing is recorded anywhere. The one thing it cannot know
 * is history — it gets an actor with no past — so what it answers precisely is "what
 * would this look like as a first request", which is what a ticket is asking.
 */
interface TestResult {
  entry: DashboardEntry;
  reason: string;
  assumed: string[];
  error?: string;
}

export function initTester(): void {
  if (!SECTIONS.tester) return;
  $("test-run").addEventListener("click", () => void run());
  byId<HTMLTextAreaElement>("test-input").addEventListener("keydown", (event) => {
    // Enter is a newline in a textarea, so the shortcut is the one every console uses
    // for "send this".
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void run();
    }
  });
}

async function run(): Promise<void> {
  const raw = byId<HTMLTextAreaElement>("test-input").value;
  if (raw.trim() === "") {
    toast("warn", "Nothing to assess", "Paste a User-Agent, a curl command, or a header block.");
    return;
  }
  const result = await postJson<TestResult>("/api/test", {
    raw,
    ip: byId<HTMLInputElement>("test-ip").value.trim(),
    url: byId<HTMLInputElement>("test-url").value.trim(),
  });

  const box = $("test-result");
  box.hidden = false;
  clear(box);

  if (!result.ok) {
    box.className = "result bad";
    box.appendChild(el("div", null, result.error ?? "The server could not read that."));
    return;
  }

  const { entry, reason, assumed } = result.data;
  const out = outcome(entry);
  box.className = `result ${out === "deny" ? "bad" : out === "mitigate" ? "warn" : "ok"}`;

  const head = el("div");
  const [badgeClass, badgeLabel] = verdictBadge(entry);
  head.appendChild(el("span", `badge ${badgeClass}`, badgeLabel));
  head.appendChild(document.createTextNode(" "));
  head.appendChild(el("b", null, entry.action ?? "no decision"));
  if (entry.rule !== undefined) head.appendChild(el("span", "ev-meta", ` via ${entry.rule}`));
  box.appendChild(head);

  box.appendChild(el("div", "ev-meta", `${entry.certain ? "proven" : `score ${entry.score}`} · assessed in ${ms(entry.durationMs)}`));
  if (entry.downgradedFrom !== undefined) {
    box.appendChild(el("div", "guard", `The guard stopped ${entry.downgradedFrom} here.`));
    if (entry.downgradeReason !== undefined) box.appendChild(el("div", "basis", entry.downgradeReason));
  }

  if (entry.evidence.length === 0) {
    box.appendChild(el("div", "ev-meta", entry.bypass !== undefined ? `Detection was skipped: ${entry.bypass}.` : "No detector produced any evidence."));
  } else {
    const list = el("div", "ev");
    for (const item of entry.evidence) {
      const row = el("div", `ev-item${item.direction === "human" ? " human" : ""}`);
      row.appendChild(el("div", `tier t-${item.certainty}`, item.certainty));
      const detail = el("div");
      detail.appendChild(el("div", null, item.summary));
      detail.appendChild(el("div", "ev-meta", `${item.detector} · points to ${item.direction}`));
      if (item.deterministicBasis !== undefined) detail.appendChild(el("div", "basis", item.deterministicBasis));
      row.appendChild(detail);
      list.appendChild(row);
    }
    box.appendChild(list);
  }

  box.appendChild(el("div", "ev-meta", reason));

  // Said every time, not only when it matters. A tester that silently invents a client
  // address is a tester whose answer about `ip-intelligence` cannot be trusted, and the
  // reader has no way to know which run was which.
  const notes = [...assumed, "no history: this is assessed as a first request, so cadence and crawl breadth have nothing to read"];
  box.appendChild(el("div", "assumed", `Assumed — ${notes.join("; ")}.`));
}
