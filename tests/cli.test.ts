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

/**
 * `check --baseline`, which is the upgrade ritual the docs already ask for.
 *
 * An integration reported writing this script themselves on every upgrade: run the
 * corpus, dump JSON, install the new version, run it again, diff the two. It is how they
 * learned that eighteen new signatures changed nothing for their policy while five benign
 * bots moved from `block` to `rate-limit`. This makes it one command with an exit code.
 *
 * The corpus run is the slow part, so these share one baseline between them.
 */
describe("comparing a run against a baseline", () => {
  const baseline = (async (): Promise<{ path: string; parsed: { cases: Array<{ id: string; audience: string; action: string }> } }> => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cli = run(["check", "--preset", "indexers-only", "--json"]);
    await cli.code;
    const parsed = JSON.parse(cli.out()) as { cases: Array<{ id: string; audience: string; action: string }> };
    const dir = await mkdtemp(join(tmpdir(), "bothandler-baseline-"));
    const path = join(dir, "before.json");
    await writeFile(path, cli.out(), "utf8");
    return { path, parsed };
  })();

  it("records one row per case, which is what makes the file a baseline", async () => {
    const { parsed } = await baseline;
    expect(parsed.cases.length).toBeGreaterThan(100);
    // Enough to say what moved, and no more: a baseline is compared against a different
    // version of this library, so anything richer compares two moving things. Read off a
    // case that ran, since a skipped one carries one extra field saying so.
    const ran = parsed.cases.find((row) => !("skipped" in row));
    expect(Object.keys(ran as object).sort()).toEqual(["action", "audience", "id", "verdict"]);
  });

  it("says nothing moved when nothing moved, and succeeds", async () => {
    const { path } = await baseline;
    const cli = run(["check", "--preset", "indexers-only", "--baseline", path]);
    expect(await cli.code).toBe(0);
    expect(cli.out()).toContain("Nothing moved");
  });

  it("reports what moved, and fails when somebody served before is refused now", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { path, parsed } = await baseline;
    // A baseline in which two crawlers were served. They are refused in this run, which
    // is the regression an upgrade is most likely to introduce and least likely to say.
    const doctored = {
      preset: "indexers-only",
      cases: parsed.cases.map((row) => (row.action === "block" && row.audience === "benign-bot" ? { ...row, action: "allow" } : row)),
    };
    const altered = `${path}.doctored.json`;
    await writeFile(altered, JSON.stringify(doctored), "utf8");

    const cli = run(["check", "--preset", "indexers-only", "--baseline", altered]);
    expect(await cli.code, "a case that used to be served and is not now must fail the run").toBe(1);
    const text = cli.out();
    expect(text).toContain("reached a different action");
    expect(text).toContain("were served before and are not now");
    // Grouped by who they are, because an action change among hostile cases is tuning and
    // the same change among humans is an incident.
    expect(text).toContain("benign-bot");
  });

  it("says so rather than throwing when the baseline is not there", async () => {
    const cli = run(["check", "--preset", "indexers-only", "--baseline", "/nonexistent/before.json"]);
    expect(await cli.code).toBe(1);
    // The run itself succeeded, so its result is still worth printing.
    expect(cli.out()).toContain("shapes of real traffic");
    expect(cli.err()).toContain("Could not read the baseline");
  });

  it("says a baseline from an older version has nothing to compare", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { path } = await baseline;
    const old = `${path}.old.json`;
    await writeFile(old, JSON.stringify({ preset: "indexers-only", total: 500, passed: 500 }), "utf8");
    const cli = run(["check", "--preset", "indexers-only", "--baseline", old]);
    expect(await cli.code).toBe(0);
    expect(cli.out()).toContain("no per-case rows");
  });
});
