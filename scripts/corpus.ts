#!/usr/bin/env tsx
/**
 * Runs the traffic corpus against a policy and prints a scorecard.
 *
 *   npm run corpus                          # the protect-content preset
 *   npm run corpus -- --preset protect-data
 *   npm run corpus -- --audience human --verbose
 *
 * The section to read first is FALSE POSITIVES. Everything else is diagnostics; that
 * one is people your configuration would have turned away.
 */
import { BotHandler, defaultDetectors, trapDetector } from "../src/index.js";
import { PRESETS } from "../src/policy/presets.js";
import { CORPUS, AUDIENCE_STAKES } from "../src/corpus/index.js";
import { runCorpus } from "../src/corpus/runner.js";
import type { PresetName } from "../src/policy/presets.js";
import type { Audience } from "../src/corpus/schema.js";
import type { CaseResult, Scorecard } from "../src/corpus/runner.js";

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const entry = process.argv[i]!;
  if (!entry.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    flags.set(entry.slice(2), next);
    i++;
  } else flags.set(entry.slice(2), "true");
}

const preset = (flags.get("preset") ?? "protect-content") as PresetName;
if (!(preset in PRESETS)) {
  process.stderr.write(`Unknown preset "${preset}". One of: ${Object.keys(PRESETS).join(", ")}\n`);
  process.exit(1);
}

const audienceFilter = flags.get("audience") as Audience | undefined;
const tagFilter = flags.get("tag");
const verbose = flags.has("verbose");

const cases = CORPUS.filter((item) => (audienceFilter === undefined || item.audience === audienceFilter) && (tagFilter === undefined || item.tags?.includes(tagFilter) === true));

const RULE = "─".repeat(78);
const out = (line = ""): void => void process.stdout.write(`${line}\n`);

function bar(value: number, total: number, width = 24): string {
  if (total === 0) return "";
  return "█".repeat(Math.round((value / total) * width));
}

function describe(result: CaseResult): void {
  const { assessment, decision } = result.final;
  out(`  ${result.case.id}`);
  out(`    ${result.case.title}`);
  out(`    -> ${assessment.verdict} / ${assessment.botClass} / ${assessment.certain ? "proven" : `score ${assessment.score}`} -> ${decision.action} (rule "${decision.rule}")`);
  for (const failure of result.failures) out(`    ✗ ${failure}`);
  if (verbose) {
    for (const item of assessment.evidence.slice(0, 4)) out(`      [${item.certainty}] ${item.detector}: ${item.summary.slice(0, 86)}`);
  }
  out();
}

function report(scorecard: Scorecard): void {
  out();
  out(RULE);
  out(`  traffic corpus — ${scorecard.total} cases against the "${preset}" policy`);
  out(RULE);

  // --- The section that matters ---------------------------------------------
  out();
  if (scorecard.falsePositives.length === 0) {
    out(`  FALSE POSITIVES: none. No case marked as a person was denied service.`);
  } else {
    out(`  FALSE POSITIVES: ${scorecard.falsePositives.length}. These are people this configuration turns away.`);
    out(RULE);
    for (const result of scorecard.falsePositives) describe(result);
  }

  out();
  out("  by audience");
  const width = Math.max(...Object.keys(scorecard.byAudience).map((key) => key.length));
  for (const [audience, tally] of Object.entries(scorecard.byAudience)) {
    if (tally.total === 0) continue;
    const actions = Object.entries(tally.actions)
      .sort((a, b) => b[1] - a[1])
      .map(([action, count]) => `${action} ${count}`)
      .join(", ");
    out(`    ${audience.padEnd(width)}  ${String(tally.passed).padStart(3)}/${String(tally.total).padStart(3)} pass   ${actions}`);
  }

  out();
  out("  detector coverage");
  const coverage = Object.entries(scorecard.detectorCoverage).sort((a, b) => b[1] - a[1]);
  const detectorWidth = Math.max(0, ...coverage.map(([id]) => id.length));
  for (const [detector, count] of coverage) {
    out(`    ${detector.padEnd(detectorWidth)}  ${String(count).padStart(4)} cases  ${bar(count, scorecard.total)}`);
  }
  if (scorecard.unexercisedDetectors.length > 0) {
    out();
    out(`    not exercised by any case: ${scorecard.unexercisedDetectors.join(", ")}`);
    out(`    (a gap in the corpus, not the library — an untested detector regresses unnoticed)`);
  }

  const { total, proven } = scorecard.provenAutomation;
  out();
  out(`  proven automation: ${proven}/${total} of the genuinely automated cases reached a certain verdict`);
  out(`  (the rest are correctly unproven — see the evasion ladder in adversarial.ts)`);

  if (scorecard.selfDeclaredHumans.length > 0) {
    out();
    out(`  people whose client declares itself a bot (${scorecard.selfDeclaredHumans.length}) — exempt from the never-deny rule:`);
    for (const result of scorecard.selfDeclaredHumans) {
      out(`    ${result.case.id} -> ${result.final.decision.action}`);
      out(`      ${result.case.selfDeclared}`);
    }
  }

  if (scorecard.skipped.length > 0) {
    out();
    out(`  skipped (${scorecard.skipped.length}) — the handler under test is not configured for these:`);
    for (const result of scorecard.skipped) out(`    ${result.case.id}: ${result.skipped}`);
  }

  const failures = scorecard.results.filter((result) => result.failures.length > 0 && !result.falsePositive);
  if (failures.length > 0) {
    out();
    out(RULE);
    out(`  ${failures.length} other expectation mismatch(es)`);
    out(RULE);
    for (const result of failures) describe(result);
  }

  out(RULE);
  out(`  ${scorecard.passed}/${scorecard.total} cases pass  ·  ${scorecard.falsePositives.length} false positives  ·  ${scorecard.durationMs.toFixed(0)}ms`);
  out(RULE);
  out();
  if (audienceFilter !== undefined) out(`  ${audienceFilter}: ${AUDIENCE_STAKES[audienceFilter]}\n`);
}

const TRAP_FIELD = "company_url";

const scorecard = await runCorpus({
  cases,
  // Declares the trap form field, as a deployment that renders one must. Configuring
  // a built-in detector means replacing it in the list: duplicate ids are rejected, so
  // a second `trap` cannot silently shadow the first.
  provides: [`trap-form-field:${TRAP_FIELD}`, "denylist", "datacenter-ranges"],
  create: ({ resolver, clock }) =>
    new BotHandler({
      preset,
      resolver,
      clock,
      detectors: defaultDetectors().map((detector) => (detector.id === "trap" ? trapDetector({ formFields: [TRAP_FIELD] }) : detector)),
      // Operator data the library ships none of. Documentation ranges only, chosen so
      // that the datacenter set covers the corpus's VPN and privacy-relay cases —
      // people in hosting address space are the population this signal is capped for.
      datacenterRanges: ["192.0.2.128/25"],
      denylist: ["203.0.113.240/28"],
      challenge: { secrets: ["corpus-secret-used-only-by-the-traffic-corpus-runner"] },
      metrics: true,
    }),
});

report(scorecard);
process.exitCode = scorecard.falsePositives.length > 0 || scorecard.failed > 0 ? 1 : 0;
