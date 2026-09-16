import { describe, expect, it } from "vitest";
import { main, parseCommonLogLine, parseJsonLine } from "../src/cli.js";
import { BotHandler } from "../src/index.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { failingResolver } from "./helpers.js";

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

describe("log parsing", () => {
  it("reads a Combined Log Format line, timestamp and all", () => {
    const facts = parseCommonLogLine(
      '203.0.113.5 - - [30/Aug/2026:09:15:04 +0000] "GET /products/3?x=1 HTTP/1.1" 200 2326 "https://ref.example/" "curl/8.4.0"',
    )!;
    expect(facts.method).toBe("GET");
    expect(facts.path).toBe("/products/3");
    expect(facts.ip).toBe("203.0.113.5");
    expect(facts.headers["user-agent"]).toBe("curl/8.4.0");
    expect(facts.headers["referer"]).toBe("https://ref.example/");
    expect(facts.httpVersion).toBe("1.1");
    expect(facts.partialHeaders).toBe(true);
    expect(new Date(facts.timestamp).toISOString()).toBe("2026-08-30T09:15:04.000Z");
  });

  it("honours the timezone offset", () => {
    const facts = parseCommonLogLine('1.2.3.4 - - [30/Aug/2026:09:00:00 -0700] "GET / HTTP/1.1" 200 1')!;
    expect(new Date(facts.timestamp).toISOString()).toBe("2026-08-30T16:00:00.000Z");
  });

  it("treats a dash as an absent header rather than a literal one", () => {
    const facts = parseCommonLogLine('1.2.3.4 - - [30/Aug/2026:09:00:00 +0000] "GET / HTTP/1.1" 200 1 "-" "-"')!;
    expect(facts.headers["user-agent"]).toBeUndefined();
  });

  it("returns undefined for a line it cannot read", () => {
    expect(parseCommonLogLine("not a log line")).toBeUndefined();
    expect(parseJsonLine("{ broken")).toBeUndefined();
    expect(parseJsonLine('{"method":"GET"}')).toBeUndefined();
  });

  it("reads JSON lines at full fidelity when headers are present", () => {
    const facts = parseJsonLine(
      JSON.stringify({ ip: "203.0.113.7", method: "post", url: "/login", headers: { "User-Agent": "curl/8", Accept: "*/*" }, timestamp: "2026-08-30T09:00:00Z", protocol: "https" }),
    )!;
    expect(facts.method).toBe("POST");
    expect(facts.headers["user-agent"]).toBe("curl/8");
    expect(facts.protocol).toBe("https");
    expect(facts.partialHeaders).toBeUndefined();
  });

  // The CLF branch declares itself header-poor precisely so that a replay does not
  // report a site's human traffic as automation. A JSON line carrying the handful of
  // headers a logger was configured to keep is in exactly the same position, and
  // reading it as a complete capture scored the same real Chrome request 0 from CLF
  // and 87 from JSON.
  it("treats a selected subset of headers as the extract it is", async () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
    const line = JSON.stringify({
      ip: "203.0.113.44",
      method: "GET",
      url: "/",
      httpVersion: "1.1",
      headers: { host: "shop.example", "user-agent": chrome, referer: "https://shop.example/" },
    });
    const facts = parseJsonLine(line)!;
    expect(facts.partialHeaders).toBe(true);

    const assessment = await new BotHandler({ resolver: failingResolver() }).assess(facts);
    expect(assessment.score, "a browser in an access log is not evidence of automation").toBe(0);
  });

  it("still reads a full capture at full fidelity", () => {
    const line = JSON.stringify({ ip: "203.0.113.44", headers: { host: "s", "user-agent": "curl/8.4.0", accept: "*/*", "accept-encoding": "gzip" } });
    expect(parseJsonLine(line)?.partialHeaders).toBeUndefined();
  });

  it("lets the record settle it either way", () => {
    const complete = JSON.stringify({ ip: "203.0.113.44", partialHeaders: false, headers: { host: "s", "user-agent": "x" } });
    expect(parseJsonLine(complete)?.partialHeaders).toBeUndefined();
    const partial = JSON.stringify({ ip: "203.0.113.44", partial_headers: true, headers: { host: "s", accept: "*/*" } });
    expect(parseJsonLine(partial)?.partialHeaders).toBe(true);
  });

  it("marks a JSON line with no headers as header-poor", () => {
    const facts = parseJsonLine(JSON.stringify({ remote_addr: "1.2.3.4", request_uri: "/" }))!;
    expect(facts.partialHeaders).toBe(true);
  });

  it("accepts epoch seconds and milliseconds alike", () => {
    expect(parseJsonLine(JSON.stringify({ ip: "1.2.3.4", timestamp: 1_756_544_400 }))!.timestamp).toBe(1_756_544_400_000);
    expect(parseJsonLine(JSON.stringify({ ip: "1.2.3.4", timestamp: 1_756_544_400_000 }))!.timestamp).toBe(1_756_544_400_000);
  });
});

describe("the replay command", () => {
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

  async function run(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: await main(args), out, err };
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
  }

  function logFile(lines: readonly string[]): string {
    const path = join(tmpdir(), `bothandler-replay-${randomUUID()}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return path;
  }

  // `Number("all")` is NaN and every comparison against NaN is false, so both flags
  // failed silently: `--limit` stopped limiting, and `--show` printed an empty list
  // under a heading announcing that the list is the point of the exercise.
  it("refuses a numeric flag it cannot read", async () => {
    const file = logFile([JSON.stringify({ ip: "203.0.113.1", url: "/", headers: { "user-agent": "curl/8.4.0", accept: "*/*" } })]);
    for (const args of [["--show", "all"], ["--limit", "-3"], ["--limit", "lots"]]) {
      const result = await run(["replay", file, ...args]);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.err).toMatch(/needs a non-negative number/);
    }
    expect((await run(["replay", file, "--show", "3"])).code).toBe(0);
  });

  // A JSON log carrying the few headers somebody configured their logger to keep is
  // as header-poor as a CLF line, and a replay that quietly detects less while
  // reporting a clean result is the one thing this command must not produce.
  it("says so when the log it read was header-poor", async () => {
    const file = logFile([
      JSON.stringify({ ip: "203.0.113.1", url: "/", httpVersion: "1.1", headers: { host: "shop.example", "user-agent": CHROME } }),
      JSON.stringify({ ip: "203.0.113.2", url: "/", httpVersion: "1.1", headers: { host: "shop.example", "user-agent": CHROME } }),
    ]);
    const { code, out } = await run(["replay", file]);
    expect(code).toBe(0);
    expect(out).toContain("incomplete header set");
    expect(out, "a browser in an access log must not be reported as automation").toContain("unknown");
  });

  it("says nothing about fidelity when the log carried full headers", async () => {
    const file = logFile([
      JSON.stringify({
        ip: "203.0.113.1",
        url: "/",
        httpVersion: "1.1",
        headers: { host: "shop.example", "user-agent": "curl/8.4.0", accept: "*/*", "accept-encoding": "gzip" },
      }),
    ]);
    const { out } = await run(["replay", file]);
    expect(out).not.toContain("incomplete header set");
  });
});

/**
 * `bothandlerjs check` — the policy against the corpus.
 *
 * The question the whole library is organised around, asked offline and before a
 * deploy: *if I point this configuration at the actual internet, who gets hurt?* The
 * exit code is the part that belongs in CI.
 */
describe("the check command", () => {
  async function run(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: await main(args), out, err };
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
  }

  it("reports every audience, and passes when no person is denied", async () => {
    const { code, out } = await run(["check", "--preset", "protect-content"]);
    expect(out).toMatch(/human\s+\d+ cases/);
    expect(out).toContain("No case marked as a person was denied service.");
    expect(code).toBe(0);
  }, 60_000);

  it("answers in JSON for a pipeline", async () => {
    const { code, out } = await run(["check", "--preset", "monitor-only", "--json"]);
    const report = JSON.parse(out) as { preset: string; total: number; falsePositives: unknown[] };
    expect(report.preset).toBe("monitor-only");
    expect(report.total).toBeGreaterThan(400);
    expect(report.falsePositives).toEqual([]);
    expect(code).toBe(0);
  }, 60_000);

  it("narrows to one audience when asked", async () => {
    const { out } = await run(["check", "--audience", "human", "--json"]);
    const report = JSON.parse(out) as { byAudience: Record<string, { total: number }> };
    expect(report.byAudience["human"]?.total).toBeGreaterThan(100);
    expect(report.byAudience["hostile"]?.total).toBe(0);
  }, 60_000);

  it("refuses a preset and an audience it does not have", async () => {
    expect((await run(["check", "--preset", "nonsense"])).code).toBe(1);
    expect((await run(["check", "--audience", "robots"])).err).toMatch(/Unknown audience/);
  });
});

/** `bothandlerjs explain` — the dry run, for the question that arrives by ticket. */
describe("the explain command", () => {
  async function run(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: await main(args), out, err };
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
  }

  it("explains a User-Agent, with the evidence and the rule", async () => {
    const { code, out } = await run(["explain", "curl/8.4.0"]);
    expect(out).toContain("confirmed-bot");
    expect(out).toContain("self-identified");
    expect(out).toMatch(/rule\s+\S/);
    expect(code).toBe(0);
  });

  /**
   * `--preset protect-data` is two tokens and only the first looks like a flag, so
   * filtering on a leading `--` left `protect-data` behind as though somebody had typed
   * it. `explain` read it as the request and reported a verdict on the string
   * "protect-data".
   */
  it("does not mistake a flag's value for the request", async () => {
    const { out } = await run(["explain", "--preset", "protect-data", "curl/8.4.0"]);
    expect(out).toContain("curl/8.4.0");
    expect(out).not.toContain("protect-data\n");
  });

  it("takes the fields beside the request", async () => {
    const { out } = await run(["explain", "--ip", "198.51.100.9", "--url", "/checkout", "curl/8.4.0"]);
    expect(out).toContain("GET /checkout");
    expect(out).not.toContain("client address 203.0.113.1");
  });

  it("says what it assumed, and that it has no history", async () => {
    const { out } = await run(["explain", "curl/8.4.0"]);
    expect(out).toContain("Assumed —");
    expect(out).toContain("assessed as a first request");
  });

  it("answers in JSON, and refuses an empty request", async () => {
    const parsed = JSON.parse((await run(["explain", "--json", "curl/8.4.0"])).out) as { assessment: { verdict: string } };
    expect(parsed.assessment.verdict).toBe("confirmed-bot");
    expect((await run(["explain", "   "])).code).toBe(1);
  });
});
