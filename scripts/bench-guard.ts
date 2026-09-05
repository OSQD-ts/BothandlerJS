#!/usr/bin/env tsx
/**
 * The performance ratchet.
 *
 *   npm run bench:guard
 *
 * Detection runs inline on every request to the site it protects, so its cost is
 * latency added to every page a person loads. There is a coverage ratchet and there was
 * no performance one, which means a detector that got ten times slower would have
 * shipped in silence — on the one code path every user of this library runs on every
 * request.
 *
 * ## Why this measures ratios rather than microseconds
 *
 * A committed baseline in microseconds is a statement about the machine that produced
 * it. CI runners are shared, throttled and periodically re-provisioned onto different
 * hardware; a number recorded on a laptop fails on a runner for reasons that have
 * nothing to do with the code, and a suite that fails for reasons unrelated to the code
 * is a suite people disable.
 *
 * So every budget here is a **ratio against a reference loop measured in the same
 * process, on the same machine, seconds earlier**. The reference is deliberately not
 * library code — it is arithmetic and string work that no change in this repository can
 * make faster or slower — so the ratio moves only when detection does. A runner half
 * the speed of a laptop runs both halves at half speed and the ratio is unchanged.
 *
 * ## Why the budgets are loose
 *
 * They are set at roughly twice what the code costs today. That is not generosity, it
 * is the difference between a guard and a tripwire: this exists to catch a regression
 * of the kind that makes an operator's page slower, not to argue about eight per cent.
 * A budget tight enough to fire on noise gets raised until it stops firing, and then it
 * is not a guard at all.
 */
import { BotHandler, createFacts } from "../src/index.js";

const ITERATIONS = Number(process.env["ITERATIONS"] ?? 4000);
const ROUNDS = Number(process.env["ROUNDS"] ?? 5);

/**
 * The yardstick: a fixed amount of arithmetic and string building.
 *
 * Nothing in `src/` can change what this costs, which is the entire point — it measures
 * the machine, so that everything else can be measured against the machine.
 */
function reference(): number {
  let hash = 0x811c9dc5;
  let text = "";
  for (let i = 0; i < 200; i++) {
    hash ^= i;
    hash = Math.imul(hash, 0x01000193);
    if (i % 20 === 0) text += String(hash >>> 0);
  }
  return hash + text.length;
}

/** Budgets, as multiples of one reference loop. See the note above on why they are loose. */
const BUDGETS: ReadonlyArray<{ label: string; maxRatio: number; run: () => unknown }> = buildCases();

function buildCases(): ReadonlyArray<{ label: string; maxRatio: number; run: () => unknown }> {
  const handler = new BotHandler();
  const headers: Record<string, string> = {
    host: "example.test",
    "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "sec-fetch-site": "none",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "accept-language": "en-GB,en;q=0.9",
  };
  const rawHeaders = Object.entries(headers).flat();
  const clean = createFacts({ method: "GET", url: "/products/12", headers, rawHeaders, ip: "203.0.113.5" });

  // Measured at 24–25x, 30x and 7.0–7.5x across repeated runs, moving about 3% between
  // them — which is what makes a ratio usable as a budget at all. Each is set at roughly
  // double, so a change has to be a regression rather than a busy afternoon.
  return [
    // The overwhelmingly common case: a real browser, nothing firing, every detector
    // running to completion. If any number here matters, it is this one.
    { label: "assess — clean browser", maxRatio: 50, run: () => handler.assess(clean) },
    { label: "handle — clean browser", maxRatio: 60, run: () => handler.handle(clean) },
    { label: "createFacts", maxRatio: 15, run: () => createFacts({ method: "GET", url: "/products/12?ref=x", headers, rawHeaders, ip: "203.0.113.5" }) },
  ];
}

/** Median of several timed rounds, each preceded by a warm-up. Same shape as `bench.ts`. */
async function measure(run: () => unknown): Promise<number> {
  const isAsync = run() instanceof Promise;
  const samples: number[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < 1000; i++) {
      if (isAsync) await run();
      else run();
    }
    const started = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      if (isAsync) await run();
      else run();
    }
    samples.push(performance.now() - started);
  }

  samples.sort((a, b) => a - b);
  return (samples[Math.floor(samples.length / 2)] as number) / ITERATIONS;
}

async function main(): Promise<number> {
  const unit = await measure(reference);
  console.log(`\n  reference loop: ${(unit * 1000).toFixed(2)} us   (this machine's yardstick)\n`);

  let failed = 0;
  for (const budget of BUDGETS) {
    const cost = await measure(budget.run);
    const ratio = cost / unit;
    const ok = ratio <= budget.maxRatio;
    if (!ok) failed++;
    console.log(
      `  ${ok ? "ok  " : "FAIL"}  ${budget.label.padEnd(26)} ${(cost * 1000).toFixed(2).padStart(7)} us   ` +
        `${ratio.toFixed(1).padStart(5)}x reference   budget ${budget.maxRatio}x`,
    );
  }

  if (failed > 0) {
    console.log(
      `\n  ${failed} case(s) over budget. Either something on the hot path got materially slower,\n` +
        "  or the budget is genuinely wrong for a change that was worth making — in which case\n" +
        "  raise it in scripts/bench-guard.ts and say why in the commit.\n",
    );
    return 1;
  }
  console.log("\n  Everything within budget.\n");
  return 0;
}

process.exitCode = await main();
