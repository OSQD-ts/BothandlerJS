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
import { identityShape, newMarker } from "../src/probe/marker.js";
import { issueToken } from "../src/challenge/token.js";
import { parseUserAgent } from "../src/internal/ua.js";

const ITERATIONS = Number(process.env["ITERATIONS"] ?? 4000);
const ROUNDS = Number(process.env["ROUNDS"] ?? 5);

/** A shape allocated and thrown away, like the evidence and facts objects detection builds. */
interface Sample {
  name: string;
  weight: number;
  tags: string[];
}

const REFERENCE_PATTERN = /^[a-z]+-[0-9]+$/;

/**
 * The yardstick: a fixed amount of the kind of work detection actually does.
 *
 * Nothing in `src/` can change what this costs, which is the entire point — it measures
 * the machine, so that everything else can be measured against the machine.
 *
 * It used to be integer arithmetic and a little string building, and that turned out to
 * measure the wrong thing about a machine. Pure ALU work in a few hundred bytes of
 * working set is the case a wider, newer core is best at; allocating objects, hashing
 * into maps and dispatching polymorphically is the case it is only somewhat better at.
 * So the two halves did not scale together, which is the one assumption the whole ratio
 * rests on. Measured across two machines: the old reference ran 2.14x faster on the CI
 * runner than on the development laptop while `assess` ran only 1.26x faster, inflating
 * every ratio by about 1.7x and failing three budgets on a machine where detection was
 * *faster* in absolute terms.
 *
 * The mix here is deliberately closer to the thing being measured — short-lived objects,
 * map and set lookups, string building and comparison, a regular expression, array
 * iteration. It is not a model of detection, and it does not need to be. It needs to get
 * faster and slower for the same reasons detection does.
 */
function reference(): number {
  let hash = 0x811c9dc5;
  const seen = new Map<string, number>();
  const kept: Sample[] = [];
  for (let i = 0; i < 5; i++) {
    hash ^= i;
    hash = Math.imul(hash, 0x01000193);
    const name = `field-${hash >>> 24}`;
    // Allocation, and a hash lookup that misses more often than it hits.
    const sample: Sample = { name, weight: (hash >>> 8) / 0xffffff, tags: [name.slice(0, 5), `t${i % 7}`] };
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (REFERENCE_PATTERN.test(name)) kept.push(sample);
  }
  let total = 0;
  for (const sample of kept) {
    total += sample.weight + sample.tags.length;
    if (sample.name.startsWith("field-1")) total += 1;
  }
  return hash + seen.size + total;
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
  const longPath = `/${Array.from({ length: 60 }, (_, i) => `segment${i}`).join("/")}/42`;
  const deep = createFacts({ method: "GET", url: longPath, headers, rawHeaders, ip: "203.0.113.6" });
  const manyKeys = Array.from({ length: 200 }, (_, i) => `key${i}=value${i}`).join("&");
  const wide = createFacts({ method: "GET", url: `/search?${manyKeys}`, headers, rawHeaders, ip: "203.0.113.7" });

  // A handler with the probe on, and a request carrying a marker it would have issued.
  // Minted directly rather than by round-tripping a response, so this stays synchronous.
  const markerSecret = "a-bench-marker-secret-long-enough-to-pass";
  const probed = new BotHandler({ probe: { secrets: [markerSecret], secure: false } });
  const shape = identityShape(clean, parseUserAgent(headers["user-agent"]));
  const token = issueToken(newMarker(shape, 12 * 60 * 60_000, Date.now()), [markerSecret]);
  const profiled = new BotHandler({ site: { warmupRequests: 1 } });
  const marked = createFacts({
    method: "GET",
    url: "/products/12",
    headers: { ...headers, cookie: `__bh_m=${encodeURIComponent(token)}` },
    rawHeaders,
    ip: "203.0.113.8",
  });

  // Re-derived when the reference changed, because a budget is a multiple of the
  // yardstick and these were multiples of a different one. Measured over repeated runs on
  // the development machine: 26–30x for a clean assess, 30–36x for handle, 26–33x for the
  // three shaped requests and the two opt-in sources, and 4.7–5.1x for `createFacts`.
  // Each budget below is roughly double the top of its range, which is the same rule the
  // old numbers were set by and the reason a busy afternoon does not fail the build.
  return [
    // The overwhelmingly common case: a real browser, nothing firing, every detector
    // running to completion. If any number here matters, it is this one.
    { label: "assess — clean browser", maxRatio: 60, run: () => handler.assess(clean) },
    { label: "handle — clean browser", maxRatio: 70, run: () => handler.handle(clean) },
    { label: "createFacts", maxRatio: 15, run: () => createFacts({ method: "GET", url: "/products/12?ref=x", headers, rawHeaders, ip: "203.0.113.5" }) },
    // A request costs whatever its URL says it costs, and the URL is written by the
    // client. Both of these were regressions found by measuring rather than by reading:
    // building a walk template out of a sixty-segment path cost 3.65us against 199ns for
    // an ordinary one, an eighteen-fold tax anyone could levy by sending a long URL, and
    // folding two hundred query keys meant sorting two hundred keys per request. Both are
    // bounded now, and the budgets are here so they stay bounded.
    { label: "assess — very long path", maxRatio: 65, run: () => handler.assess(deep) },
    { label: "assess — many query keys", maxRatio: 70, run: () => handler.assess(wide) },
    // The marker probe is opt-in, and what it costs an ordinary request is the number
    // that decides whether anyone opts in. Verifying a marker is an HMAC; a session
    // presents the same cookie every time, so the verification is cached and this
    // measures the cached path, which is the one real traffic takes.
    { label: "assess — marker held", maxRatio: 65, run: () => probed.assess(marked) },
    // The site profile is opt-in and touches three bounded tables per request. What it
    // costs an ordinary request is the number that decides whether anyone turns it on.
    { label: "assess — site profile on", maxRatio: 65, run: () => profiled.assess(clean) },
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
