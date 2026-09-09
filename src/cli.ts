#!/usr/bin/env node
/**
 * The command line.
 *
 * The command that matters is `replay`. A bot policy is a claim about *your* traffic,
 * and the only way to check a claim like that before it starts turning people away is
 * to run it over traffic you already have. Point it at an access log and it reports
 * what would have happened — including a list of every request it would have denied,
 * so you can read them and decide whether any of them are people.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { BotHandler } from "./core.js";
import { createFacts } from "./facts.js";
import { PRESETS } from "./policy/presets.js";
import { robotsFromRules } from "./robots.js";
import { DEFAULT_TRAP_PATHS } from "./detectors/trap.js";
import type { PresetName } from "./policy/presets.js";
import type { Assessment, RequestFacts } from "./types.js";
import type { Decision } from "./policy/types.js";

const USAGE = `bothandlerjs — bot traffic detection

  bothandlerjs replay <file> [options]   Replay an access log and report what would have happened
  bothandlerjs check [--preset <p>]      Run a policy against the traffic corpus: who would it hurt?
  bothandlerjs explain [request]         Assess one request and show the evidence behind the verdict
  bothandlerjs robots [options]          Generate a robots.txt from a policy preset
  bothandlerjs detectors [--preset <p>]  List the detectors a configuration installs
  bothandlerjs --help | --version

check options
  --preset <name>     Which policy to test (default protect-content)
  --audience <a>      Only cases for one audience: human | benign-bot | declared-bot |
                      unwanted-bot | hostile | infrastructure
  --json              Emit the scorecard as JSON
  --strict            Also fail on cases whose expected action differs (default: only
                      the invariants — nothing marked as a person may be denied)

explain
  Reads a User-Agent, a curl command or a block of request headers, from an argument
  or from stdin:

    bothandlerjs explain "curl/8.4.0"
    pbpaste | bothandlerjs explain --preset protect-data
    bothandlerjs explain --ip 203.0.113.9 --url /checkout "Mozilla/5.0 ..."

replay options
  --preset <name>     monitor-only | protect-content | protect-data | protect-auth  (default protect-content)
  --limit <n>         Stop after n parsed lines
  --show <n>          How many would-be-denied requests to print in full (default 10)
  --json              Emit the report as JSON instead of text
  --format <f>        clf | json  (default: detected from the first line)

Accepted input
  Combined/Common Log Format, as nginx and Apache write by default.
  JSON Lines, one object per line: { ip, method, url, headers, timestamp }.

  JSON Lines is strongly preferred. A CLF line carries only the User-Agent and the
  Referer, so every header-consistency detector is blind on it — a replay over CLF
  under-reports, and its silence is not evidence of a clean bill of health.
`;

interface ReplayCounters {
  parsed: number;
  skipped: number;
  /** Records whose header set was known to be incomplete. See `RequestFacts.partialHeaders`. */
  headerPoor: number;
  verdicts: Map<string, number>;
  actions: Map<string, number>;
  detectors: Map<string, number>;
  downgrades: number;
  denied: Array<{ assessment: Assessment; decision: Decision }>;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write("bothandlerjs 0.2.0\n");
    return 0;
  }

  const flags = parseFlags(rest);

  switch (command) {
    case "replay":
      return replay(rest[0], flags);
    case "check":
      return check(flags);
    case "explain": {
      // `undefined` and `""` mean different things here: nothing on the command line is
      // an invitation to read the pipe, and an empty argument is a mistake to report.
      const given = positionals(rest);
      return explain(given.length === 0 ? undefined : given.join(" "), flags);
    }
    case "robots":
      return robots(flags);
    case "detectors":
      return detectors(flags);
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

// ---------------------------------------------------------------------------

async function replay(file: string | undefined, flags: Map<string, string>): Promise<number> {
  if (file === undefined || file.startsWith("--")) {
    process.stderr.write("replay needs a file: bothandlerjs replay access.log\n");
    return 1;
  }

  const preset = (flags.get("preset") ?? "protect-content") as PresetName;
  if (!(preset in PRESETS)) {
    process.stderr.write(`Unknown preset "${preset}". One of: ${Object.keys(PRESETS).join(", ")}\n`);
    return 1;
  }

  // Validated rather than coerced. `Number("all")` is NaN, every comparison against
  // NaN is false, and the failure is silent in both directions: `--limit` stops
  // limiting, and `--show` prints an empty list under a heading announcing that the
  // list is the point of the exercise.
  const limit = numericFlag(flags, "limit", Number.POSITIVE_INFINITY);
  const show = numericFlag(flags, "show", 10);
  if (limit === undefined || show === undefined) return 1;

  // A replay must never resolve DNS. It would be thousands of lookups for addresses
  // that may no longer route anywhere, and the verification result would describe
  // today's DNS rather than the day the traffic happened.
  const handler = new BotHandler({
    preset,
    resolver: { reverse: () => Promise.reject(new Error("offline")), resolveAddresses: () => Promise.reject(new Error("offline")) },
    metrics: true,
  });

  const counters: ReplayCounters = {
    parsed: 0,
    skipped: 0,
    headerPoor: 0,
    verdicts: new Map(),
    actions: new Map(),
    detectors: new Map(),
    downgrades: 0,
    denied: [],
  };

  let format = flags.get("format");

  // A read error surfaces twice — once on the stream, once as a rejection from the
  // `for await` below — so it is reported once, here, and the loop is allowed to
  // unwind quietly rather than printing a second, uglier copy of the same problem.
  let readError: NodeJS.ErrnoException | undefined;
  const stream = createReadStream(file, { encoding: "utf8" });
  stream.on("error", (error: NodeJS.ErrnoException) => {
    readError = error;
  });

  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of lines) {
      if (counters.parsed >= limit) break;
      const text = line.trim();
      if (text.length === 0) continue;

      format ??= text.startsWith("{") ? "json" : "clf";
      const facts = format === "json" ? parseJsonLine(text) : parseCommonLogLine(text);
      if (facts === undefined) {
        counters.skipped++;
        continue;
      }

      counters.parsed++;
      if (facts.partialHeaders === true) counters.headerPoor++;
      const assessment = await handler.assess(facts);
      const decision = handler.decide(assessment);

      bump(counters.verdicts, assessment.verdict);
      bump(counters.actions, decision.action);
      // Distinct detectors per request. Counting evidence items instead lets one
      // detector contribute several to a single request and produce a "share of
      // requests" above 100%, which is not a share of anything.
      const fired = new Set<string>();
      for (const item of assessment.evidence) fired.add(item.detector);
      for (const detector of fired) bump(counters.detectors, detector);
      if (decision.downgradedFrom !== undefined) counters.downgrades++;
      if (decision.action === "block" || decision.action === "drop" || decision.action === "redirect") {
        if (counters.denied.length < 500) counters.denied.push({ assessment, decision });
      }
    }
  } catch (error) {
    readError ??= error as NodeJS.ErrnoException;
  }

  if (readError !== undefined) {
    process.stderr.write(readError.code === "ENOENT" ? `No such file: ${file}\n` : `Cannot read ${file}: ${readError.message}\n`);
    return 1;
  }

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ preset, format, ...summarise(counters), metrics: handler.metrics() }, null, 2)}\n`);
    return 0;
  }

  report(counters, { preset, format: format ?? "clf", show, actors: handler.registry.size });
  return 0;
}

/** Reads a positive numeric flag, or reports the problem and returns `undefined`. */
function numericFlag(flags: Map<string, string>, name: string, fallback: number): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    process.stderr.write(`--${name} needs a non-negative number; received "${raw}".\n`);
    return undefined;
  }
  return value;
}

function summarise(counters: ReplayCounters): Record<string, unknown> {
  return {
    parsed: counters.parsed,
    skipped: counters.skipped,
    headerPoor: counters.headerPoor,
    verdicts: Object.fromEntries(counters.verdicts),
    actions: Object.fromEntries(counters.actions),
    detectors: Object.fromEntries(counters.detectors),
    downgrades: counters.downgrades,
    denied: counters.denied.map(({ assessment, decision }) => ({
      method: assessment.facts.method,
      path: assessment.facts.path,
      ip: assessment.facts.ip,
      userAgent: assessment.facts.headers["user-agent"],
      verdict: assessment.verdict,
      rule: decision.rule,
      evidence: assessment.evidence.map((item) => ({ detector: item.detector, certainty: item.certainty, summary: item.summary })),
    })),
  };
}

function report(counters: ReplayCounters, context: { preset: string; format: string; show: number; actors: number }): void {
  const rule = "─".repeat(74);
  const out = (line = "") => process.stdout.write(`${line}\n`);

  out();
  out(rule);
  out(`  replay — ${counters.parsed.toLocaleString()} requests, preset "${context.preset}", format ${context.format}`);
  out(rule);
  if (counters.skipped > 0) out(`  ${counters.skipped.toLocaleString()} line(s) could not be parsed and were skipped.`);
  out(`  ${context.actors.toLocaleString()} distinct actors seen.`);
  // Driven by what was actually read rather than by the file's format. A JSON log
  // carrying the handful of headers somebody configured their logger to keep is as
  // header-poor as a CLF line, and a replay that quietly detects less while reporting
  // a clean result is the one outcome this command must not produce.
  if (counters.headerPoor > 0) {
    const share = counters.parsed === 0 ? 0 : (counters.headerPoor / counters.parsed) * 100;
    const everyLine = counters.headerPoor === counters.parsed;
    out();
    out(`  NOTE: ${everyLine ? "every line" : `${counters.headerPoor.toLocaleString()} line(s), ${share.toFixed(0)}%,`} carried an incomplete header set, so every`);
    out("  detector that reasons from a missing header stood down for them. What you see");
    out("  below is a floor, not a full picture.");
    out(context.format === "clf"
      ? "  A CLF line records only the User-Agent and the Referer — log JSON with the full"
      : "  Log the request's full header set — a selected few fields are not enough for");
    out(context.format === "clf" ? "  header set to replay at full fidelity." : "  the header-consistency detectors to say anything.");
  }

  out();
  out("  verdicts");
  table(out, counters.verdicts, counters.parsed);
  out();
  out("  what would have happened");
  table(out, counters.actions, counters.parsed);

  if (counters.detectors.size > 0) {
    out();
    out("  detectors that fired");
    table(out, counters.detectors, counters.parsed);
  }

  out();
  if (counters.downgrades > 0) {
    out(`  ${counters.downgrades.toLocaleString()} request(s) matched a rule asking to deny service and were downgraded`);
    out(`  by the safety guard for lack of proof. Those are requests your policy wanted`);
    out(`  to block and could not justify blocking.`);
  } else {
    out("  No rule asked to deny service without proof.");
  }

  const denied = counters.denied;
  out();
  out(rule);
  if (denied.length === 0) {
    out("  Nothing would have been denied.");
    out(rule);
    return;
  }

  // One entry per distinct (rule, client, reason). A hundred identical sqlmap lines
  // teach less than one line saying "sqlmap, a hundred times", and the whole purpose
  // of this list is that a person reads all of it.
  const groups = new Map<string, { count: number; assessment: Assessment; decision: Decision }>();
  for (const entry of denied) {
    const key = `${entry.decision.rule}|${entry.assessment.facts.headers["user-agent"] ?? ""}|${entry.assessment.evidence[0]?.detector ?? ""}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { count: 1, assessment: entry.assessment, decision: entry.decision });
  }
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count);

  out(`  ${denied.length.toLocaleString()}${denied.length >= 500 ? "+" : ""} request(s) would have been DENIED, in ${ranked.length} distinct kind(s). Read them.`);
  out(rule);
  out("  This list is the point of the exercise. Every entry is a request your policy");
  out("  would have refused; if any of them is a person, your policy is wrong.");
  out();

  for (const { count, assessment, decision } of ranked.slice(0, context.show)) {
    out(`  ${String(count).padStart(6)}x  ${decision.action} by rule "${decision.rule}" — ${assessment.verdict}${assessment.certain ? ", proven" : `, score ${assessment.score}`}`);
    out(`          ${(assessment.facts.headers["user-agent"] ?? "(no User-Agent)").slice(0, 84)}`);
    out(`          e.g. ${assessment.facts.method} ${assessment.facts.path} from ${assessment.facts.ip}`);
    for (const item of assessment.evidence.slice(0, 3)) {
      out(`          [${item.certainty}] ${item.detector}: ${item.summary.slice(0, 80)}`);
    }
    out();
  }
  if (ranked.length > context.show) out(`  ... and ${ranked.length - context.show} more kind(s). Use --show <n>, or --json for everything.`);
  out(rule);
}

function table(out: (line?: string) => void, counts: Map<string, number>, total: number): void {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const width = Math.max(0, ...rows.map(([key]) => key.length));
  for (const [key, value] of rows) {
    const share = total === 0 ? 0 : (value / total) * 100;
    const bar = "█".repeat(Math.round(share / 4));
    out(`    ${key.padEnd(width)}  ${String(value).padStart(8)}  ${share.toFixed(1).padStart(5)}%  ${bar}`);
  }
}

// ---------------------------------------------------------------------------

/**
 * Runs a policy against the traffic corpus.
 *
 * The question this library is organised around, asked offline and before a deploy:
 * *if I point this configuration at the actual internet, who gets hurt?* The corpus is
 * 526 shapes of real traffic with provenance — real User-Agent strings, real header
 * sets in the order real clients send them — and a large share of them are people.
 *
 * One number in the output matters more than the rest, and it is the exit code: a
 * policy that denies service to any case marked `human` fails, whatever else it got
 * right. That check runs against every human case regardless of what that case's own
 * expectations say, so a case added tomorrow protects you the moment somebody writes it
 * down.
 *
 * DNS is controlled rather than real, the clock is manual, and every case gets its own
 * address — so this is reproducible, offline, and safe to put in CI.
 */
async function check(flags: Map<string, string>): Promise<number> {
  const preset = (flags.get("preset") ?? "protect-content") as PresetName;
  if (!(preset in PRESETS)) {
    process.stderr.write(`Unknown preset "${preset}". One of: ${Object.keys(PRESETS).join(", ")}\n`);
    return 1;
  }

  const audience = flags.get("audience");
  const audiences: readonly string[] = ["human", "benign-bot", "declared-bot", "unwanted-bot", "hostile", "infrastructure"];
  if (audience !== undefined && !audiences.includes(audience)) {
    process.stderr.write(`Unknown audience "${audience}". One of: ${audiences.join(", ")}\n`);
    return 1;
  }

  const { CORPUS } = await import("./corpus/index.js");
  const { runCorpus } = await import("./corpus/runner.js");

  const cases = audience === undefined ? CORPUS : CORPUS.filter((entry) => entry.audience === audience);
  const scorecard = await runCorpus({
    create: ({ resolver, clock }) => new BotHandler({ preset, resolver, clock, metrics: true }),
    cases,
    // The presets are what the corpus's action expectations were written against, so
    // asserting them is meaningful here in a way it would not be for somebody's own
    // rules. `--strict` is for treating an action difference as a failure rather than
    // as a policy decision.
    assertActions: flags.has("strict"),
    // A preset installs the detectors and nothing else: no denylist, no datacenter
    // ranges, no trap field of your own. Cases needing those are skipped and counted
    // rather than failed, because their absence is a fact about this configuration and
    // not a defect in it. `crawler-ranges` is supplied by the runner itself.
    provides: ["crawler-ranges"],
  });

  if (flags.has("json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          preset,
          total: scorecard.total,
          passed: scorecard.passed,
          failed: scorecard.failed,
          falsePositives: scorecard.falsePositives.map((result) => ({ id: result.case.id, title: result.case.title, action: result.final.decision.action })),
          skipped: scorecard.skipped.length,
          byAudience: scorecard.byAudience,
          unexercisedDetectors: scorecard.unexercisedDetectors,
        },
        null,
        2,
      )}\n`,
    );
    return scorecard.falsePositives.length > 0 || (flags.has("strict") && scorecard.failed > 0) ? 1 : 0;
  }

  const lines: string[] = [];
  lines.push(`\n  ${preset} against ${scorecard.total} shapes of real traffic\n`);
  for (const [name, tally] of Object.entries(scorecard.byAudience)) {
    if (tally.total === 0) continue;
    const actions = Object.entries(tally.actions)
      .filter(([, count]) => count > 0)
      .map(([action, count]) => `${count} ${action}`)
      .join(", ");
    lines.push(`  ${name.padEnd(15)} ${String(tally.total).padStart(4)} cases   ${actions}`);
  }
  if (scorecard.skipped.length > 0) lines.push(`\n  ${scorecard.skipped.length} skipped — the case needs something this configuration does not install.`);

  if (scorecard.falsePositives.length > 0) {
    lines.push(`\n  ${scorecard.falsePositives.length} PERSON(S) DENIED SERVICE — this policy turns people away:\n`);
    for (const result of scorecard.falsePositives) {
      lines.push(`    ${result.final.decision.action.padEnd(9)} ${result.case.id}`);
      lines.push(`              ${result.case.title}`);
      lines.push(`              ${result.case.provenance}`);
    }
  } else {
    lines.push("\n  No case marked as a person was denied service.");
  }

  if (flags.has("strict") && scorecard.failed > 0) {
    lines.push(`\n  ${scorecard.failed} case(s) reached a different action than expected:`);
    for (const result of scorecard.results.filter((entry) => entry.failures.length > 0).slice(0, 20)) {
      lines.push(`    ${result.case.id}: ${result.failures.join("; ")}`);
    }
  }

  if (scorecard.unexercisedDetectors.length > 0) {
    lines.push(`\n  Detectors no case exercised: ${scorecard.unexercisedDetectors.join(", ")}`);
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));

  return scorecard.falsePositives.length > 0 || (flags.has("strict") && scorecard.failed > 0) ? 1 : 0;
}

/**
 * Assesses one request and explains the verdict.
 *
 * The question that arrives by ticket rather than by traffic: *why is this client being
 * challenged?* It takes whatever you have to hand — a User-Agent out of a support
 * email, a curl command out of devtools, a header block out of a log — and runs a **dry
 * run**, so nothing is recorded anywhere and asking does not change the answer.
 *
 * It has no history, by construction: the actor it assesses has never been seen, so
 * `cadence`, `crawl-breadth` and `rate-anomaly` have nothing to read. What it answers
 * exactly is *what would this look like as a first request*, which is what a ticket is
 * asking anyway.
 */
async function explain(input: string | undefined, flags: Map<string, string>): Promise<number> {
  const preset = (flags.get("preset") ?? "protect-content") as PresetName;
  if (!(preset in PRESETS)) {
    process.stderr.write(`Unknown preset "${preset}". One of: ${Object.keys(PRESETS).join(", ")}\n`);
    return 1;
  }

  // Only an *absent* argument waits on stdin. An empty one is answered now, because a
  // command that silently blocks on a pipe nobody is writing to is a command that looks
  // like it has hung — and in a script, one that has.
  const raw = input === undefined ? await readStdin() : input;
  if (raw.trim() === "") {
    process.stderr.write('explain needs a request: bothandlerjs explain "curl/8.4.0", or pipe one in\n');
    return 1;
  }

  const { parseRequest } = await import("./dashboard/parse-request.js");
  let parsed: ReturnType<typeof parseRequest>;
  try {
    parsed = parseRequest(raw, {
      ip: flags.get("ip"),
      url: flags.get("url"),
      method: flags.get("method"),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Offline, for the same reason `replay` is: a lookup would describe today's DNS
  // rather than anything about the request in front of you, and it would be a
  // surprising thing for a command like this to do to somebody's network.
  const handler = new BotHandler({
    preset,
    resolver: { reverse: () => Promise.reject(new Error("offline")), resolveAddresses: () => Promise.reject(new Error("offline")) },
  });

  const facts = createFacts({ method: parsed.method, url: parsed.url, headers: parsed.headers, ip: parsed.ip, protocol: "https", httpVersion: "1.1" });
  const assessment = await handler.assess(facts, { record: false });
  const decision = handler.policy.decide(assessment);

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ assessment: { ...assessment, facts: undefined }, decision, assumed: parsed.assumed }, null, 2)}\n`);
    return 0;
  }

  const lines = [
    "",
    `  ${parsed.method} ${parsed.url}   ${parsed.headers["user-agent"] ?? "(no User-Agent)"}`,
    "",
    `  verdict     ${assessment.verdict}${assessment.identity === undefined ? "" : ` (${assessment.identity})`}`,
    `  certainty   ${assessment.certain ? "proven" : `probabilistic, score ${assessment.score}`}`,
    `  class       ${assessment.botClass}`,
    `  action      ${decision.action}${decision.downgradedFrom === undefined ? "" : `  (the guard stopped ${decision.downgradedFrom})`}`,
    `  rule        ${decision.rule}`,
    "",
    `  ${decision.reason}`,
    "",
  ];

  if (assessment.evidence.length + assessment.humanEvidence.length === 0) {
    lines.push("  No detector produced any evidence.", "");
  } else {
    for (const item of [...assessment.evidence, ...assessment.humanEvidence]) {
      lines.push(`  ${item.certainty.padEnd(9)} ${item.detector.padEnd(22)} ${item.summary}`);
      if (item.deterministicBasis !== undefined) lines.push(`            ${item.deterministicBasis}`);
    }
    lines.push("");
  }

  // Said every time. A tool that silently invents a client address is one whose answer
  // about `ip-intelligence` cannot be trusted, and the reader cannot tell which run was
  // which.
  lines.push(`  Assumed — ${[...parsed.assumed, "no history: assessed as a first request"].join("; ")}.`, "");
  process.stdout.write(lines.join("\n"));
  return 0;
}

/** Everything on stdin, for `… | bothandlerjs explain`. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function robots(flags: Map<string, string>): number {
  const preset = (flags.get("preset") ?? "protect-data") as PresetName;
  const build = PRESETS[preset];
  if (!build) {
    process.stderr.write(`Unknown preset "${preset}". One of: ${Object.keys(PRESETS).join(", ")}\n`);
    return 1;
  }
  const sitemap = flags.get("sitemap");
  const result = robotsFromRules(build(), {
    disallowPaths: DEFAULT_TRAP_PATHS,
    ...(sitemap !== undefined ? { sitemap } : {}),
    header: [`# Generated by bothandlerjs from the "${preset}" policy.`, "# robots.txt is a request, not enforcement. Everything that ignores it is the point."],
  });
  process.stdout.write(result.robotsTxt);
  for (const entry of result.unreadable) {
    process.stderr.write(`note: rule "${entry.rule}" was not reflected — ${entry.reason}\n`);
  }
  // On stderr, so a redirect into robots.txt stays clean while the reasoning still
  // reaches whoever ran the command.
  if (result.served.length > 0) {
    process.stderr.write(`note: not declined, because an earlier rule serves them — ${result.served.join(", ")}\n`);
  }
  return 0;
}

function detectors(flags: Map<string, string>): number {
  const preset = flags.get("preset") as PresetName | undefined;
  // Refused rather than ignored, the way `robots` above refuses it. An unknown preset
  // used to fall through to a handler with no preset at all and print the default list
  // as though it were the answer — so a typo produced a confident wrong answer to the
  // one question this command exists for.
  if (preset !== undefined && !(preset in PRESETS)) {
    process.stderr.write(`Unknown preset "${preset}". One of: ${Object.keys(PRESETS).join(", ")}\n`);
    return 1;
  }
  const handler = new BotHandler(preset !== undefined ? { preset } : {});
  const installed = handler.describeDetectors();
  for (const entry of installed) {
    process.stdout.write(`${entry.id.padEnd(24)} ${entry.cost.padEnd(6)} ${entry.stage.padEnd(11)} ${entry.description}\n`);
  }
  process.stdout.write(`\n${installed.length} detectors installed.\n`);
  // A preset is a set of rules, so it does not change this list — which the flag's
  // presence implies and which is worth saying rather than leaving somebody to infer
  // from two identical outputs. What does change it is on stderr, so a redirect of the
  // list stays clean.
  process.stderr.write("note: a preset selects rules, not detectors. `challenge`, `probe` and `site` are what add to this list.\n");
  return 0;
}

// ---------------------------------------------------------------------------

/** `1.2.3.4 - - [10/Oct/2000:13:55:36 -0700] "GET /p HTTP/1.1" 200 2326 "ref" "ua"` */
const COMMON_LOG = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)(?: (HTTP\/[\d.]+))?" (\d{3}) (\S+)(?: "([^"]*)" "([^"]*)")?/;

export function parseCommonLogLine(line: string): RequestFacts | undefined {
  const match = COMMON_LOG.exec(line);
  if (!match) return undefined;

  const headers: Record<string, string | string[] | undefined> = {};
  const referer = match[8];
  const userAgent = match[9];
  if (referer !== undefined && referer !== "-") headers["referer"] = referer;
  if (userAgent !== undefined && userAgent !== "-") headers["user-agent"] = userAgent;

  const timestamp = parseClfTime(match[2]!);
  return createFacts({
    method: match[3]!,
    url: match[4]!,
    headers,
    ip: match[1]!,
    // A CLF line records the User-Agent and the Referer and nothing else. Without
    // this flag every browser in the log looks like a client that sent no Accept and
    // no Accept-Language, which is how a replay ends up reporting most of a site's
    // human traffic as suspected automation.
    partialHeaders: true,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(match[5] !== undefined ? { httpVersion: match[5].slice(5) } : {}),
  });
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** `10/Oct/2000:13:55:36 -0700`. Timestamps matter: they drive every behavioural detector. */
function parseClfTime(value: string): number | undefined {
  const match = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
  if (!match) return undefined;
  const month = MONTHS[match[2]!];
  if (month === undefined) return undefined;
  const utc = Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]));
  const offset = (Number(match[8]) * 60 + Number(match[9])) * 60_000 * (match[7] === "-" ? -1 : 1);
  return utc - offset;
}

export function parseJsonLine(line: string): RequestFacts | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;

  const ip = firstString(record, ["ip", "remote_addr", "client_ip", "remoteAddress"]);
  if (ip === undefined) return undefined;

  const rawHeaders = record["headers"];
  const hasHeaders = typeof rawHeaders === "object" && rawHeaders !== null;
  const headers = (hasHeaders ? rawHeaders : {}) as Record<string, string | string[] | undefined>;
  const timestamp = readTimestamp(record);

  return createFacts({
    method: firstString(record, ["method", "request_method", "verb"]) ?? "GET",
    url: firstString(record, ["url", "path", "request_uri", "uri", "request"]) ?? "/",
    headers,
    ip,
    ...(isCompleteCapture(record, headers) ? {} : { partialHeaders: true as const }),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(firstString(record, ["httpVersion", "http_version"]) !== undefined ? { httpVersion: firstString(record, ["httpVersion", "http_version"])! } : {}),
    ...(firstString(record, ["protocol", "scheme"]) === "https" ? { protocol: "https" as const } : {}),
  });
}

/**
 * Headers a real capture has and a selected-subset access log does not.
 *
 * Every browser sends `Accept` and `Accept-Encoding`; almost no logger is configured
 * to record them, because nobody reads them. Their presence is therefore a good
 * indicator that the `headers` object is the request rather than an extract of it.
 */
const FULL_CAPTURE_MARKERS = ["accept", "accept-encoding", "accept-language", "sec-fetch-mode", "sec-fetch-dest", "sec-ch-ua"];

/**
 * Is this record's `headers` object the whole request, or the handful of fields
 * somebody configured their logger to keep?
 *
 * It used to be taken at its word whenever it existed, and that is wrong for the
 * shape almost every JSON access log actually has. nginx, Envoy and CloudFront all
 * log a chosen subset — typically host, user-agent and referer — and reading that
 * subset as complete means every browser in the file is a client that sent no
 * `Accept`, no `Accept-Language` and no `Accept-Encoding`. The same Chrome request
 * scored 0 replayed from a CLF line and 87 from a JSON one, purely because the CLF
 * branch declares itself header-poor and this one did not.
 *
 * A record may say so itself, which settles it. Otherwise completeness is inferred
 * from whether the object carries headers a logger would have had no reason to keep.
 */
function isCompleteCapture(record: Record<string, unknown>, headers: Record<string, string | string[] | undefined>): boolean {
  const declared = record["partialHeaders"] ?? record["partial_headers"];
  if (typeof declared === "boolean") return !declared;
  const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  return FULL_CAPTURE_MARKERS.some((marker) => names.has(marker));
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readTimestamp(record: Record<string, unknown>): number | undefined {
  for (const key of ["timestamp", "time", "@timestamp", "ts", "date"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      // Seconds or milliseconds: anything below this bound is not a plausible ms epoch.
      return value < 100_000_000_000 ? value * 1000 : value;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Flags that take a value. Everything else is on or off.
 *
 * Named explicitly because the alternative — "a flag swallows the next token unless
 * that token is another flag" — cannot tell `--json curl/8.4.0` from `--preset
 * protect-data`. It read the request as the value of `--json`, left no positional
 * argument at all, and `explain` sat waiting on a pipe nobody was writing to.
 */
const VALUE_FLAGS = new Set(["preset", "audience", "limit", "show", "format", "ip", "url", "method"]);

/**
 * The arguments that are neither a flag nor a flag's value.
 *
 * `--preset protect-data` is two tokens and only the first looks like a flag, so
 * filtering on a leading `--` leaves `protect-data` behind as though somebody had typed
 * it as input — and `explain` duly reported a verdict on the string "protect-data".
 */
function positionals(argv: readonly string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const entry = argv[i]!;
    if (!entry.startsWith("--")) {
      rest.push(entry);
      continue;
    }
    if (entry.includes("=")) continue;
    if (VALUE_FLAGS.has(entry.slice(2)) && argv[i + 1] !== undefined) i++;
  }
  return rest;
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const entry = argv[i]!;
    if (!entry.startsWith("--")) continue;
    const equals = entry.indexOf("=");
    if (equals !== -1) {
      flags.set(entry.slice(2, equals), entry.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(entry.slice(2)) && next !== undefined && !next.startsWith("--")) {
      flags.set(entry.slice(2), next);
      i++;
    } else {
      flags.set(entry.slice(2), "true");
    }
  }
  return flags;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
