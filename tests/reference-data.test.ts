import { describe, expect, it } from "vitest";
import { REFERENCE } from "../src/dashboard/client/reference.generated.js";
import { plainText, referenceKey } from "../src/dashboard/client/reference-model.js";
import type { Block, Inline } from "../src/dashboard/client/reference-model.js";
import { ACTION_NAMES } from "../src/policy/types.js";
import { BotHandler } from "../src/index.js";

/**
 * The Reference screen's text, generated from `docs/`.
 *
 * The parser is small on purpose and the documents are free to change shape, so what is
 * pinned here is what the screen promises rather than how the markdown is read: every name
 * the dashboard can link to has an entry with something in it, and nothing arrives as
 * anything other than text.
 */
const keys = new Set(REFERENCE.entries.map((entry) => referenceKey(entry.kind, entry.id)));

function inlinesOf(block: Block): Inline[][] {
  if (block.kind === "p" || block.kind === "h") return [block.text];
  if (block.kind === "list") return block.items;
  if (block.kind === "table") return [...block.head, ...block.rows.flat()];
  return [];
}

describe("the reference data", () => {
  it("has an entry for every action a rule can name", () => {
    const missing = ACTION_NAMES.filter((name) => !keys.has(referenceKey("action", name)));
    expect(missing, "actions the dashboard links to with nothing to open").toEqual([]);
  });

  it("has an entry for every detector that can be installed", () => {
    const withEverything = new BotHandler({
      onWarning: () => {},
      probe: { secrets: ["a-reference-guard-secret-long-enough-to-pass"], secure: false },
      challenge: { secrets: ["a-reference-guard-challenge-secret-long-enough"] },
      site: { warmupRequests: 10 },
    });
    const ids = [...withEverything.describeDetectors().map((entry) => entry.id), "identity-rotation", "tls-fingerprint"];
    const missing = ids.filter((id) => !keys.has(referenceKey("detector", id)));
    expect(missing, "detectors that would open on an empty page").toEqual([]);
  });

  it("gives every entry a summary and a body", () => {
    for (const entry of REFERENCE.entries) {
      expect(entry.summary.length, `${entry.kind} ${entry.id} summary`).toBeGreaterThan(0);
      expect(entry.blocks.length, `${entry.kind} ${entry.id} body`).toBeGreaterThan(0);
    }
  });

  it("reads each detector's cost, stage and ceiling off its facts line", () => {
    const cadence = REFERENCE.entries.find((entry) => entry.id === "cadence");
    expect(cadence?.facts).toEqual(["cheap", "always", "ceiling moderate"]);
    // The facts line is taken out of the body rather than shown twice.
    expect(plainText((cadence?.blocks[0] as { text: Inline[] }).text)).not.toContain("ceiling");
    expect(REFERENCE.entries.find((entry) => entry.id === "block")?.facts[0]).toBe("terminal");
  });

  it("gathers the correlation detectors' text from the page that explains them", () => {
    const campaign = REFERENCE.entries.find((entry) => entry.id === "path-campaign");
    const text = campaign?.blocks.flatMap(inlinesOf).map(plainText).join(" ") ?? "";
    expect(text).toContain("broken link");
    // And not a neighbour's: the paragraph about distributed-walk's bounds is its own.
    expect(text).not.toContain("revisit ratio");
  });

  it("keeps link targets and markdown syntax out of the text", () => {
    for (const entry of REFERENCE.entries) {
      for (const runs of entry.blocks.flatMap(inlinesOf)) {
        for (const [kind, text] of runs) {
          expect(["t", "b", "i", "code"], entry.id).toContain(kind);
          if (kind !== "code") expect(text, `${entry.id}: ${text}`).not.toMatch(/\]\(|\*\*|`/);
        }
      }
    }
  });
});
