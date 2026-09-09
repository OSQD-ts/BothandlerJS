import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOT_SIGNATURES } from "../src/detectors/known-bots.js";
import { CORPUS } from "../src/corpus/index.js";
import { BotHandler } from "../src/index.js";

/**
 * Numbers the documentation states as fact.
 *
 * A page that says "205 signatures" is making a claim somebody will check, and the ones
 * here had all drifted: the signature count was written when there were 161, the corpus
 * was described as 526 cases when it held 545, and the detector count had been "twenty"
 * across two releases that added to it. None of it was wrong when written and all of it
 * became wrong quietly, because nothing connects the prose to the thing it counts.
 *
 * Only counts that can be derived mechanically are pinned here. Prose that says "a page
 * per question" is deliberately left alone — a number that has to be maintained by hand
 * is a number that will be wrong again, and the fix for most of them was to stop giving
 * one rather than to keep it current.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

describe("what the documentation says there is", () => {
  it("counts the signature database correctly", () => {
    const claimed = `${BOT_SIGNATURES.length} signatures`;
    for (const page of ["docs/detection/signatures.md", "docs/course/06-identity.md", "docs/course/05-detectors.md"]) {
      expect(read(page), page).toContain(claimed);
    }
  });

  it("counts the corpus correctly", () => {
    const cases = CORPUS.length;
    // Each page phrases it its own way — "545 cases" in one, "545 shapes of real traffic"
    // in another — so the assertion is the number *attached to what it counts*, rather
    // than the number appearing loose somewhere on the page.
    const counted = new RegExp(`\\b${cases}\\b\\s+(cases|shapes|corpus cases)`);
    for (const page of ["docs/start/installation.md", "README.md", "docs/index.md"]) {
      expect(read(page), page).toMatch(counted);
    }

    let requests = 0;
    let headerLines = 0;
    const categories = new Set<string>();
    for (const item of CORPUS) {
      requests += item.requests.length;
      for (const request of item.requests) headerLines += request.headers.length;
      categories.add(item.category);
    }
    // The whole headline sentence, not its parts. Asserting that each number appears
    // *somewhere* on the page is not an assertion: a stale headline still passes it,
    // because the correct figure appears further down in the sample scorecard. Checked
    // that way, this test agreed the corpus held 999 cases.
    const headline = `${cases} cases, ${requests.toLocaleString("en-GB")} requests, ${headerLines.toLocaleString("en-GB")} header lines, ${categories.size} categories`;
    expect(read("docs/testing/corpus.md"), "the corpus overview's opening line").toContain(headline);
  });

  /**
   * The audience table, which had drifted by twenty-two cases before anybody noticed.
   *
   * It is the part of the corpus page somebody reads to decide whether the corpus covers
   * their traffic, so a stale row is worse than no row: it understates how many people are
   * in there, which is the number the whole guarantee rests on. The headline count above
   * was guarded and stayed right; these were not, and did not.
   */
  it("counts each audience correctly on the corpus page", () => {
    const page = read("docs/testing/corpus.md");
    const counts = new Map<string, number>();
    for (const item of CORPUS) counts.set(item.audience, (counts.get(item.audience) ?? 0) + 1);
    for (const [audience, count] of counts) {
      expect(page, `the ${audience} row`).toContain(`| **${audience}** | ${count} |`);
    }
    expect([...counts.values()].reduce((total, count) => total + count, 0), "and they add up to the corpus").toBe(CORPUS.length);
  });

  it("documents every detector that can be installed", () => {
    // Including the two that ship exported and are never installed by default, and the
    // ten that arrive only with `probe`, `challenge` or `site` — those are the ones an
    // operator has to read about *before* switching anything on, so they are the ones it
    // would be worst to leave out. Adding a detector without documenting it is the drift
    // this catches; it nearly happened when the correlation sources landed.
    const withEverything = new BotHandler({
      onWarning: () => {},
      probe: { secrets: ["a-docs-guard-secret-long-enough-to-pass"], secure: false },
      challenge: { secrets: ["a-docs-guard-challenge-secret-long-enough"] },
      site: { warmupRequests: 10 },
    });
    const ids = new Set([...withEverything.describeDetectors().map((entry) => entry.id), "identity-rotation", "tls-fingerprint"]);
    const prose = ["docs/detection/detectors.md", "docs/detection/correlation.md", "docs/detection/client-signals.md"].map(read).join("\n");
    const undocumented = [...ids].filter((id) => !prose.includes(id));
    expect(undocumented, "detectors an operator can turn on and cannot read about").toEqual([]);
  });

  it("counts the detectors installed by default correctly", () => {
    const installed = new BotHandler({ onWarning: () => {} }).describeDetectors().length;
    // Spelled out in the course, which is where the number is used to teach rather than
    // to describe, so it is worth being exact about.
    const words: Record<number, string> = { 20: "Twenty", 21: "Twenty-one", 22: "Twenty-two", 23: "Twenty-three" };
    const word = words[installed];
    expect(word, `no spelling for ${installed} detectors — add one`).toBeDefined();
    expect(read("docs/course/05-detectors.md")).toContain(`${word as string} ship on by default`);
  });
});
