#!/usr/bin/env tsx
/**
 * Hot-path benchmark.
 *
 *   npm run bench
 *
 * Detection runs inline on every request to the site it protects, so its cost is not
 * an abstract number — it is latency added to every page a person loads. This exists
 * so that a change which quietly makes that worse shows up before it ships.
 *
 * The numbers to watch are `assess` and `handle` on a **clean browser request**. That
 * is the overwhelmingly common case, it exercises every detector to completion
 * (nothing short-circuits, because nothing fires), and it is the one path where a
 * regression costs real people time.
 */
import { BotHandler, createFacts } from "../src/index.js";
import { compileSignatures } from "../src/detectors/known-bots.js";
import { parseUserAgent } from "../src/internal/ua.js";
import { ActorState } from "../src/state.js";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const HEADERS: Record<string, string> = {
  host: "example.test",
  connection: "keep-alive",
  "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "upgrade-insecure-requests": "1",
  "user-agent": CHROME,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  "accept-encoding": "gzip, deflate, br",
  "accept-language": "en-GB,en;q=0.9",
  cookie: "sid=abc",
};
const RAW_HEADERS = Object.entries(HEADERS).flat();

const iterations = Number(process.env["ITERATIONS"] ?? 20_000);
const rounds = Number(process.env["ROUNDS"] ?? 7);

const collect = (globalThis as { gc?: () => void }).gc;

/**
 * Times one case and reports the **median** of several rounds.
 *
 * A single timed loop is not a measurement. An earlier version of this script did
 * exactly that and reported the same unchanged function at 18, 21 and 62 microseconds
 * across three consecutive runs — swings large enough to hide any regression it
 * existed to catch. Three things cause that, and all three are handled here:
 *
 * - **JIT state.** The first thousands of calls measure the compiler warming up, so
 *   each round warms before it times, and the median discards a round that was
 *   unlucky with a deoptimisation.
 * - **Garbage from earlier cases.** A collection triggered inside a timed loop is
 *   charged to whichever case happened to be running, not to the one that allocated.
 *   Collecting between rounds moves that cost outside the measurement.
 * - **A megamorphic call site.** Calling `run()` through one shared closure variable
 *   across a dozen different functions costs more with every case added. Awaiting a
 *   value that is not a promise adds a scheduler turn on top. Synchronous cases now
 *   run through a loop with no `await` at all.
 */
async function measure(label: string, run: () => unknown): Promise<void> {
  const isAsync = run() instanceof Promise;
  const samples: number[] = [];
  let allocated = 0;

  for (let round = 0; round < rounds; round++) {
    if (isAsync) {
      for (let i = 0; i < 2000; i++) await run();
    } else {
      for (let i = 0; i < 2000; i++) run();
    }
    collect?.();

    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    if (isAsync) {
      for (let i = 0; i < iterations; i++) await run();
    } else {
      for (let i = 0; i < iterations; i++) run();
    }
    samples.push(performance.now() - started);
    allocated = Math.max(allocated, (process.memoryUsage().heapUsed - heapBefore) / iterations);
  }

  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  const spread = ((samples[samples.length - 1]! - samples[0]!) / median) * 100;

  const perOp = (median / iterations) * 1000;
  const perSecond = Math.round(iterations / (median / 1000));
  const memory = collect === undefined ? "" : `   ~${Math.max(0, allocated).toFixed(0).padStart(4)} B/op`;
  console.log(`  ${label.padEnd(30)} ${perOp.toFixed(2).padStart(7)} us   ${perSecond.toLocaleString().padStart(10)} ops/s   ±${spread.toFixed(0).padStart(3)}%${memory}`);
}

async function main(): Promise<void> {
  console.log(`\nbothandlerjs — median of ${rounds} rounds x ${iterations.toLocaleString()} iterations`);
  console.log(`node ${process.version}${collect === undefined ? "  (run with --expose-gc for allocation figures)" : ""}\n`);

  const handler = new BotHandler();
  const facts = createFacts({ method: "GET", url: "/products/12", headers: HEADERS, rawHeaders: RAW_HEADERS, ip: "203.0.113.5" });
  const botFacts = createFacts({ method: "GET", url: "/", headers: { host: "example.test", "user-agent": "python-requests/2.31.0" }, ip: "203.0.113.6" });

  console.log("end to end");
  await measure("createFacts", () => createFacts({ method: "GET", url: "/products/12?ref=x", headers: HEADERS, rawHeaders: RAW_HEADERS, ip: "203.0.113.5" }));
  await measure("assess — clean browser", () => handler.assess(facts));
  await measure("assess — proven bot", () => handler.assess(botFacts));
  await measure("handle — clean browser", () => handler.handle(facts));

  console.log("\ncomponents");
  const matcher = compileSignatures();
  const lower = CHROME.toLowerCase();
  const state = new ActorState("bench", 0);
  for (let i = 0; i < 32; i++) state.record({ ...facts, timestamp: i * 1000 });

  await measure("parseUserAgent", () => parseUserAgent(CHROME));
  await measure("signature match (no match)", () => matcher.matchAll(lower));
  await measure("actor intervalStats", () => state.intervalStats());
  await measure("actor requestsWithin", () => state.requestsWithin(10_000, 32_000));

  console.log("\n  ± is the spread between the fastest and slowest round. Anything above about");
  console.log("  20% means the machine is too busy for the numbers to mean much.\n");
}

void main();
