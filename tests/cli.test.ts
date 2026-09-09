import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

/**
 * The command-line tool.
 *
 * It had no tests. `main` is exported and returns an exit code, so the commands can be
 * driven directly — the only thing needing care is that they write to the real streams,
 * which is also the thing worth asserting: this tool is designed to be redirected, and
 * which stream a line goes to is part of its contract.
 */
function run(argv: readonly string[]): { code: Promise<number>; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (chunk: string): boolean => (out.push(String(chunk)), true);
  (process.stderr as { write: unknown }).write = (chunk: string): boolean => (err.push(String(chunk)), true);
  const code = main(argv).finally(() => {
    (process.stdout as { write: unknown }).write = stdout;
    (process.stderr as { write: unknown }).write = stderr;
  });
  return { code, out: () => out.join(""), err: () => err.join("") };
}

describe("the detectors command", () => {
  it("lists what is installed, and says so on stdout", async () => {
    const cli = run(["detectors"]);
    expect(await cli.code).toBe(0);
    expect(cli.out()).toContain("self-identified");
    expect(cli.out()).toMatch(/\d+ detectors installed\./);
  });

  /**
   * `robots` refused an unknown preset and this did not — it fell through to a handler
   * with no preset and printed the default list as though that were the answer. A typo
   * therefore produced a confident wrong answer to the one question the command exists
   * for, at exit code 0.
   */
  it("refuses a preset it does not have, rather than answering anyway", async () => {
    const cli = run(["detectors", "--preset=nonsense-typo"]);
    expect(await cli.code).toBe(1);
    expect(cli.err()).toContain('Unknown preset "nonsense-typo"');
    expect(cli.out()).toBe("");
  });

  it("accepts a preset it does have", async () => {
    const cli = run(["detectors", "--preset=under-attack"]);
    expect(await cli.code).toBe(0);
    expect(cli.out()).toMatch(/\d+ detectors installed\./);
  });

  /**
   * A preset selects rules, so it cannot change this list. Two identical outputs with a
   * flag between them invite the opposite conclusion, so the command says which settings
   * actually do change it — on stderr, so redirecting the list stays clean.
   */
  it("says what does and does not change the list, without dirtying stdout", async () => {
    const withPreset = run(["detectors", "--preset=under-attack"]);
    await withPreset.code;
    const without = run(["detectors"]);
    await without.code;
    expect(withPreset.out()).toBe(without.out());
    expect(withPreset.err()).toContain("a preset selects rules, not detectors");
    expect(withPreset.out()).not.toContain("note:");
  });
});

describe("the robots command", () => {
  it("writes a robots.txt to stdout and its reasoning to stderr", async () => {
    const cli = run(["robots", "--preset=protect-content"]);
    expect(await cli.code).toBe(0);
    // Redirecting stdout into robots.txt has to produce a valid file, so nothing
    // conversational may appear there.
    expect(cli.out()).toContain("User-agent:");
    expect(cli.out()).not.toContain("note:");
  });

  it("refuses a preset it does not have", async () => {
    const cli = run(["robots", "--preset=nonsense-typo"]);
    expect(await cli.code).toBe(1);
    expect(cli.err()).toContain('Unknown preset "nonsense-typo"');
  });

  it("takes a sitemap when it is given one", async () => {
    const cli = run(["robots", "--preset=protect-content", "--sitemap=https://shop.test/sitemap.xml"]);
    expect(await cli.code).toBe(0);
    expect(cli.out()).toContain("https://shop.test/sitemap.xml");
  });
});

describe("the tool's own front door", () => {
  it("explains itself and succeeds when asked for help", async () => {
    for (const argv of [[], ["--help"], ["help"]]) {
      const cli = run(argv);
      expect(await cli.code, argv.join(" ")).toBe(0);
      expect(cli.out(), argv.join(" ")).toContain("bothandlerjs");
    }
  });

  it("refuses a command it does not have", async () => {
    const cli = run(["not-a-command"]);
    expect(await cli.code).toBe(1);
  });
});
