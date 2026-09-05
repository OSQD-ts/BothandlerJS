#!/usr/bin/env tsx
/**
 * Bot traffic simulator.
 *
 *   npm run demo        # terminal 1
 *   npm run simulate    # terminal 2
 *
 * Points a range of clients at the demo site — real browsers, bare HTTP libraries,
 * scanners, forged crawlers, a verified crawler, scrapers, and a couple of traps —
 * and prints what the library concluded about each.
 *
 * It has two modes. The **curated scenarios** are eighteen narrative cases written to
 * be read: each names what it expects and why, and together they walk the demo through
 * its whole policy. **Corpus replay** (`--corpus`) sends the 513-case traffic corpus
 * over the same socket, which tests considerably more — the adapter, Node's header
 * parsing, whether wire order survives to `rawHeaders`, cookie parsing, and address
 * resolution through the forwarding headers. A case that passes in-process and fails
 * on the wire has found an adapter bug.
 *
 * **Everything goes over a raw socket rather than `fetch`.** That is not
 * gratuitous: Node's fetch normalises the header set, adds headers of its own, and
 * fixes the order. Several detectors read exactly those properties, so a simulator
 * built on `fetch` would be unable to impersonate anything convincingly — and, worse,
 * would make every scenario look like the same client.
 *
 * Each scenario runs from its own source address (the demo server trusts
 * `X-Forwarded-For`) so it is a distinct actor and one scenario's history cannot
 * contaminate the next.
 */
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { CORPUS } from "../src/corpus/index.js";
import { addressFor } from "../src/corpus/runner.js";
import type { Audience, CaseRequest, TrafficCase } from "../src/corpus/schema.js";

// Must track the demo server's defaults; both are overridable for a second instance.
const BASE = new URL(process.env["SITE_URL"] ?? "http://127.0.0.1:9673");
const GUI_PORT = process.env["GUI_PORT"] ?? "9674";
const HOST = BASE.hostname;
const PORT = Number(BASE.port || 80);

// ---------------------------------------------------------------------------
// A minimal HTTP/1.1 client with full control over the header set and its order.
// ---------------------------------------------------------------------------

type Header = readonly [name: string, value: string];

interface Reply {
  status: number;
  verdict: string;
  ms: number;
  error?: string;
  /** Parsed from the demo's verdict headers, when it is exposing them. */
  botClass?: string;
  certain?: boolean;
  score?: number;
  /**
   * What the server actually did, inferred from the response.
   *
   * The wire does not carry the policy's chosen action, but it carries enough to
   * recover the part that matters: a 403 is a refusal, a 429 with a content security
   * policy is the challenge interstitial, a 429 with a rate-limit header is a limit.
   */
  action?: "block" | "challenge" | "rate-limit" | "redirect" | "served" | "dropped" | undefined;
}

let sourceIp = "203.0.113.1";

function request(method: string, path: string, headers: readonly Header[], body?: string): Promise<Reply> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    let data = "";
    let settled = false;

    const finish = (reply: Reply): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reply);
    };

    socket.setTimeout(10_000, () => finish({ status: 0, verdict: "-", ms: Date.now() - started, error: "timeout" }));
    socket.on("error", (error) => finish({ status: 0, verdict: "-", ms: Date.now() - started, error: error.message }));

    socket.on("connect", () => {
      // Host first, exactly as a browser sends it; then the caller's headers in the
      // order they gave them; then the forwarding header a proxy would have added.
      const lines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${HOST}:${PORT}`,
        ...headers.map(([name, value]) => `${name}: ${value}`),
        ...(body !== undefined ? [`Content-Length: ${Buffer.byteLength(body)}`] : []),
        `X-Forwarded-For: ${sourceIp}`,
        // The demo sits behind a (simulated) TLS-terminating proxy. Several checks
        // are HTTPS-only by design, because Client Hints and Sec-Fetch-* are not
        // sent over plaintext and their absence there proves nothing.
        "X-Forwarded-Proto: https",
        "Connection: close",
        "",
        body ?? "",
      ];
      socket.write(lines.join("\r\n"));
    });

    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });

    socket.on("close", () => finish(parseReply(data, Date.now() - started)));
  });
}

/**
 * Reconstructs everything the response tells us.
 *
 * The demo exposes its verdict headers for exactly this reason; in production you
 * would leave `exposeVerdictHeaders` off, and then only the shape of the response is
 * available — which is still enough to tell a refusal from a challenge from a limit.
 */
function parseReply(data: string, ms: number): Reply {
  const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(data)?.[1] ?? 0);
  const header = (name: string): string | undefined => new RegExp(`^${name}:\\s*(.+)$`, "im").exec(data)?.[1]?.trim();

  const reply: Reply = {
    status,
    verdict: header("x-bot-verdict") ?? inferVerdict(status, data),
    ms,
    action: inferAction(status, data),
  };
  const botClass = header("x-bot-class");
  if (botClass !== undefined) reply.botClass = botClass;
  const certain = header("x-bot-certain");
  if (certain !== undefined) reply.certain = certain === "1";
  const score = header("x-bot-score");
  if (score !== undefined) reply.score = Number(score);
  return reply;
}

/** Maps a response back to the action that produced it. */
function inferAction(status: number, raw: string): Reply["action"] {
  if (status === 0) return "dropped";
  if (status === 403) return "block";
  if (status === 429) return /content-security-policy/i.test(raw) ? "challenge" : "rate-limit";
  if (status >= 300 && status < 400 && /^location:/im.test(raw)) return "redirect";
  return "served";
}

/** When verdict headers are not exposed, the response shape still says a lot. */
function inferVerdict(status: number, raw: string): string {
  if (status === 429 && /content-security-policy/i.test(raw)) return "challenged";
  if (status === 429) return "rate-limited";
  if (status === 403) return "blocked";
  if (status === 0) return "-";
  return "served";
}

// ---------------------------------------------------------------------------
// Header sets, written out the way each client actually sends them.
// ---------------------------------------------------------------------------

const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** A current Chrome navigation, in Chrome's own header order. */
function chrome(extra: readonly Header[] = []): Header[] {
  return [
    ["sec-ch-ua", '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"'],
    ["sec-ch-ua-mobile", "?0"],
    ["sec-ch-ua-platform", '"macOS"'],
    ["Upgrade-Insecure-Requests", "1"],
    ["User-Agent", CHROME_UA],
    ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"],
    ["Sec-Fetch-Site", "same-origin"],
    ["Sec-Fetch-Mode", "navigate"],
    ["Sec-Fetch-User", "?1"],
    ["Sec-Fetch-Dest", "document"],
    ["Accept-Encoding", "gzip, deflate, br"],
    ["Accept-Language", "en-GB,en;q=0.9"],
    ...extra,
  ];
}

/** python-requests: User-Agent, then Accept-Encoding *before* Accept. */
function pythonRequests(): Header[] {
  return [
    ["User-Agent", "python-requests/2.31.0"],
    ["Accept-Encoding", "gzip, deflate"],
    ["Accept", "*/*"],
  ];
}

// ---------------------------------------------------------------------------
// Corpus replay
//
// The traffic corpus already describes 513 clients in full — every header, in the
// order the client sends it. Replaying it over a real socket tests something the
// in-process runner cannot: that the *whole stack* behaves, including the adapter,
// Node's header parsing, whether wire order survives to `rawHeaders`, cookie parsing,
// and client-address resolution through the forwarding headers.
//
// A case that passes in-process and fails here has found an adapter bug.
// ---------------------------------------------------------------------------

interface CaseOutcome {
  case: TrafficCase;
  replies: Reply[];
  failures: string[];
  falsePositive: boolean;
}

const DENYING = new Set(["block", "drop", "redirect", "dropped"]);

/**
 * Sends one corpus request verbatim.
 *
 * The case's own headers go out exactly as written, in their own order, including its
 * `Host` — that ordering is the whole point of the fixture and rewriting it here
 * would test a client that does not exist. The forwarding headers a proxy would have
 * added are appended afterwards, which is where a proxy really does add them.
 */
function sendCase(request: CaseRequest, ip: string): Promise<Reply> {
  const started = Date.now();
  const method = request.method ?? "GET";
  const path = request.path ?? "/";
  const headers = request.headers.map(([name, value]) => `${name}: ${value}`);
  if (!request.headers.some(([name]) => name.toLowerCase() === "host")) headers.unshift(`Host: ${HOST}:${PORT}`);

  // Some fixtures declare a Content-Length for a body they do not carry. Sending the
  // header without the bytes would leave the server's body parser waiting for data
  // that never comes, so a filler body of exactly the declared size is synthesised.
  const declared = request.headers.find(([name]) => name.toLowerCase() === "content-length")?.[1];
  const contentType = request.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  const length = declared === undefined ? 0 : Number(declared);
  const body = length > 0 ? fillerBody(length, contentType) : "";

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    let data = "";
    let settled = false;
    const finish = (reply: Reply): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reply);
    };

    socket.setTimeout(10_000, () => finish({ status: 0, verdict: "-", ms: Date.now() - started, error: "timeout", action: "dropped" }));
    socket.on("error", (error) => finish({ status: 0, verdict: "-", ms: Date.now() - started, error: error.message, action: "dropped" }));
    socket.on("connect", () => {
      socket.write(
        [
          `${method} ${path} HTTP/1.1`,
          ...headers,
          `X-Forwarded-For: ${ip}`,
          `X-Forwarded-Proto: ${request.protocol ?? "https"}`,
          "Connection: close",
          "",
          body,
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("close", () => finish(parseReply(data, Date.now() - started)));
  });
}

function fillerBody(length: number, contentType: string): string {
  if (contentType.includes("json")) {
    const padding = Math.max(0, length - 12);
    return `{"_":"${"x".repeat(padding)}"}`.slice(0, length).padEnd(length, "x");
  }
  return `_=${"x".repeat(Math.max(0, length - 2))}`;
}

/**
 * Whether a case can be replayed over the wire at all, and why not when it cannot.
 *
 * Three kinds of case are unreachable from a socket, and each is skipped rather than
 * failed: an HTTP/2 fixture cannot be sent down an HTTP/1.1 connection; a case that
 * declares its own DNS answers needs a resolver the demo does not have; and a case
 * that arrives already holding clearance needs a token only the server can mint.
 */
/**
 * What the demo server is configured for.
 *
 * A case declaring a requirement the demo does not meet is skipped rather than failed:
 * the trap detector cannot recognise a form field whose name it was never given, and
 * an address-reputation case cannot fire without ranges the demo does not load.
 */
const DEMO_PROVIDES = new Set(["trap-form-field:company_url"]);

function unreplayable(item: TrafficCase): string | undefined {
  const missing = (item.requires ?? []).filter((capability) => !DEMO_PROVIDES.has(capability));
  if (missing.length > 0) return `needs configuration the demo does not have: ${missing.join(", ")}`;
  if (item.dns !== undefined) return "declares its own DNS answers, which a live server cannot be given";
  if (item.clearance !== undefined) return "needs a clearance token only the server can mint";
  if (item.requests.some((request) => request.httpVersion !== undefined && !request.httpVersion.startsWith("1"))) {
    return "is an HTTP/2 fixture and cannot be sent over an HTTP/1.1 socket";
  }
  if (item.requests.some((request) => request.partialHeaders === true)) return "models a header-poor source, which has no wire equivalent";
  // Node's own HTTP parser answers 400 to a message carrying both Content-Length and
  // Transfer-Encoding, before any handler runs — which is the correct thing for it to
  // do and means the request never becomes a `RequestFacts` on this runtime. The
  // detector still earns its place for facts built somewhere Node's parser is not in
  // the path: an edge worker, a WAF event, a log line, another runtime.
  if (item.requests.some((request) => hasHeader(request, "content-length") && hasHeader(request, "transfer-encoding"))) {
    return "is refused by Node's HTTP parser before any handler sees it";
  }
  return undefined;
}

function hasHeader(request: TrafficCase["requests"][number], name: string): boolean {
  return request.headers.some(([header]) => header.toLowerCase() === name);
}

function checkCase(item: TrafficCase, replies: Reply[]): { failures: string[]; falsePositive: boolean } {
  const failures: string[] = [];
  const final = replies[replies.length - 1]!;

  if (final.error !== undefined) failures.push(`transport error: ${final.error}`);

  const expectVerdict = item.expect.verdict;
  if (expectVerdict !== undefined && final.verdict !== "-") {
    const allowed = Array.isArray(expectVerdict) ? expectVerdict : [expectVerdict];
    if (!allowed.includes(final.verdict as never)) failures.push(`verdict was "${final.verdict}", expected ${allowed.join(" or ")}`);
  }
  if (item.expect.certain !== undefined && final.certain !== undefined && final.certain !== item.expect.certain) {
    failures.push(`certain was ${final.certain}, expected ${item.expect.certain}`);
  }

  let falsePositive = false;
  if (item.audience === "human" && item.selfDeclared === undefined) {
    for (const [index, reply] of replies.entries()) {
      if (reply.action !== undefined && DENYING.has(reply.action)) {
        falsePositive = true;
        failures.push(`FALSE POSITIVE: request ${index + 1}/${replies.length} from a person was ${reply.action}ed over the wire (HTTP ${reply.status})`);
      }
    }
  }
  for (const forbidden of item.expect.neverAction ?? []) {
    if (replies.some((reply) => reply.action === forbidden)) failures.push(`action "${forbidden}" is forbidden for this case`);
  }
  return { failures, falsePositive };
}

async function replayCorpus(flags: Map<string, string>): Promise<number> {
  const audience = flags.get("audience") as Audience | undefined;
  const tag = flags.get("tag");
  const category = flags.get("category");
  const only = flags.get("case");
  const limit = Number(flags.get("limit") ?? Number.POSITIVE_INFINITY);
  // Real gaps run to a minute; replaying them literally would take hours. The divisor
  // preserves relative spacing, which is what the behavioural detectors read.
  const speed = Math.max(1, Number(flags.get("speed") ?? 25));
  const maxGapMs = 400;

  const selected = CORPUS.filter(
    (item) =>
      (audience === undefined || item.audience === audience) &&
      (tag === undefined || item.tags?.includes(tag) === true) &&
      (category === undefined || item.category === category) &&
      (only === undefined || item.id === only),
  ).slice(0, limit);

  if (selected.length === 0) {
    process.stderr.write("No corpus case matched those filters.\n");
    return 1;
  }

  const rule = "\u2500".repeat(78);
  console.log(`\n${rule}`);
  console.log(`  replaying ${selected.length} corpus case(s) over a real socket against ${BASE.origin}`);
  console.log(`  timings compressed ${speed}x; watch it land on http://localhost:${GUI_PORT}/`);
  console.log(rule);

  const outcomes: CaseOutcome[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const verbose = flags.has("verbose");

  for (const item of selected) {
    const reason = unreplayable(item);
    if (reason !== undefined) {
      skipped.push({ id: item.id, reason });
      continue;
    }

    const ip = item.requests[0]?.ip ?? addressFor(item.id);
    const replies: Reply[] = [];
    let previousAt = 0;
    for (const request of item.requests) {
      const gap = Math.min(maxGapMs, Math.round(((request.atMs ?? 0) - previousAt) / speed));
      if (gap > 0) await sleep(gap);
      previousAt = request.atMs ?? previousAt;
      replies.push(await sendCase(request, request.ip ?? ip));
    }

    const { failures, falsePositive } = checkCase(item, replies);
    outcomes.push({ case: item, replies, failures, falsePositive });

    if (verbose || failures.length > 0) {
      const final = replies[replies.length - 1]!;
      console.log(`\n  ${item.id}  ${item.title}`);
      console.log(`    ${replies.length} request(s) -> HTTP ${final.status} (${final.action}) verdict=${final.verdict}${final.certain === true ? " proven" : final.score !== undefined ? ` score ${final.score}` : ""}`);
      for (const failure of failures) console.log(`    \u2717 ${failure}`);
    }
  }

  return reportCorpus(outcomes, skipped, rule);
}

function reportCorpus(outcomes: CaseOutcome[], skipped: Array<{ id: string; reason: string }>, rule: string): number {
  const falsePositives = outcomes.filter((outcome) => outcome.falsePositive);
  const failed = outcomes.filter((outcome) => outcome.failures.length > 0);

  console.log(`\n${rule}`);
  if (falsePositives.length === 0) {
    console.log("  FALSE POSITIVES: none. No case marked as a person was denied over the wire.");
  } else {
    console.log(`  FALSE POSITIVES: ${falsePositives.length}. These are people this deployment turns away.`);
    for (const outcome of falsePositives) console.log(`    ${outcome.case.id}: ${outcome.case.title}`);
  }
  console.log(rule);

  const byAudience = new Map<string, { total: number; failed: number; actions: Map<string, number> }>();
  for (const outcome of outcomes) {
    const tally = byAudience.get(outcome.case.audience) ?? { total: 0, failed: 0, actions: new Map<string, number>() };
    tally.total++;
    if (outcome.failures.length > 0) tally.failed++;
    const action = outcome.replies[outcome.replies.length - 1]?.action ?? "unknown";
    tally.actions.set(action, (tally.actions.get(action) ?? 0) + 1);
    byAudience.set(outcome.case.audience, tally);
  }

  console.log("\n  by audience");
  const width = Math.max(...[...byAudience.keys()].map((key) => key.length));
  for (const [name, tally] of byAudience) {
    const actions = [...tally.actions].sort((a, b) => b[1] - a[1]).map(([action, count]) => `${action} ${count}`).join(", ");
    console.log(`    ${name.padEnd(width)}  ${String(tally.total - tally.failed).padStart(3)}/${String(tally.total).padStart(3)} pass   ${actions}`);
  }

  if (skipped.length > 0) {
    console.log(`\n  skipped (${skipped.length}) — no wire equivalent:`);
    const reasons = new Map<string, number>();
    for (const entry of skipped) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
    for (const [reason, count] of reasons) console.log(`    ${String(count).padStart(3)}x  ${reason}`);
  }

  console.log(`\n${rule}`);
  console.log(`  ${outcomes.length - failed.length}/${outcomes.length} replayed cases pass  \u00b7  ${falsePositives.length} false positives`);
  console.log(rule);
  console.log();
  return falsePositives.length > 0 || failed.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Scenario {
  id: string;
  title: string;
  /** What the library should conclude. Printed so a wrong result is obvious. */
  expect: string;
  ip: string;
  run: () => Promise<Reply[]>;
}

const SCENARIOS: Scenario[] = [
  {
    id: "human",
    title: "A person in Chrome",
    expect: "served, verdict unknown — the result that matters most",
    ip: "203.0.113.10",
    run: async () => {
      const replies: Reply[] = [];
      // Ragged pacing and revisits: a person reads, goes back, follows a link.
      const journey: Array<[string, number]> = [
        ["/", 900], ["/products", 2400], ["/products/7", 5100],
        ["/products", 800], ["/products/12", 3300], ["/search?q=widget", 1500], ["/login", 2100],
      ];
      let referer: string | undefined;
      for (const [path, pause] of journey) {
        const extra: Header[] = [["Cookie", "sid=demo-session-1"]];
        if (referer) extra.unshift(["Referer", `http://${HOST}:${PORT}${referer}`]);
        replies.push(await request("GET", path, chrome(extra)));
        referer = path;
        await sleep(pause / 6); // compressed so the demo does not take a minute
      }
      return replies;
    },
  },
  {
    id: "curl",
    title: "curl",
    expect: "proven http-client -> challenged",
    ip: "203.0.113.20",
    run: async () => [
      await request("GET", "/", [["User-Agent", "curl/8.4.0"], ["Accept", "*/*"]]),
      await request("GET", "/api/items", [["User-Agent", "curl/8.4.0"], ["Accept", "*/*"]]),
    ],
  },
  {
    id: "python",
    title: "python-requests",
    expect: "proven http-client -> challenged (also trips header-order)",
    ip: "203.0.113.21",
    run: async () => [await request("GET", "/", pythonRequests()), await request("GET", "/api/items", pythonRequests())],
  },
  {
    id: "go",
    title: "Go http client",
    expect: "proven http-client -> challenged",
    ip: "203.0.113.22",
    run: async () => [await request("GET", "/api/items", [["User-Agent", "Go-http-client/2.0"], ["Accept-Encoding", "gzip"]])],
  },
  {
    id: "scanner",
    title: "Vulnerability scanners",
    expect: "proven scanner -> blocked",
    ip: "203.0.113.30",
    run: async () => [
      await request("GET", "/", [["User-Agent", "sqlmap/1.7.2#stable (https://sqlmap.org)"], ["Accept", "*/*"]]),
      await request("GET", "/login", [["User-Agent", "Mozilla/5.00 (Nikto/2.5.0)"], ["Accept", "*/*"]]),
      await request("GET", "/api/items", [["User-Agent", "Nuclei - Open-source project (github.com/projectdiscovery/nuclei)"], ["Accept", "*/*"]]),
    ],
  },
  {
    id: "headless",
    title: "Headless Chrome, not hiding",
    expect: "proven automation -> challenged",
    ip: "203.0.113.40",
    run: async () => [
      await request("GET", "/", [
        ["sec-ch-ua", '"HeadlessChrome";v="122", "Chromium";v="122", "Not(A:Brand";v="24"'],
        ["sec-ch-ua-mobile", "?0"],
        ["sec-ch-ua-platform", '"Linux"'],
        ["User-Agent", CHROME_UA.replace("Chrome/", "HeadlessChrome/")],
        ["Accept", "text/html,application/xhtml+xml,*/*;q=0.8"],
        ["Accept-Encoding", "gzip, deflate"],
        ["Accept-Language", "en-US"],
      ]),
    ],
  },
  {
    id: "spoofed-browser",
    title: "A scraper wearing a Chrome User-Agent",
    expect: "suspected only -> the guard downgrades block to challenge",
    ip: "203.0.113.50",
    run: async () => {
      const headers: Header[] = [
        ["User-Agent", CHROME_UA], // claims Chrome 122 over a connection with no hints,
        ["Accept", "*/*"], // no document Accept, no Sec-Fetch-*, no Accept-Language
        ["Accept-Encoding", "gzip, deflate"],
      ];
      return [await request("GET", "/", headers), await request("GET", "/products", headers), await request("GET", "/api/items", headers)];
    },
  },
  {
    id: "platform-mismatch",
    title: "Chrome UA whose Client Hints disagree with it",
    expect: "suspected (strong, not proven — privacy extensions do this too)",
    ip: "203.0.113.51",
    run: async () => [
      await request("GET", "/", [
        ["sec-ch-ua", '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"'],
        ["sec-ch-ua-mobile", "?0"],
        ["sec-ch-ua-platform", '"Windows"'], // the UA says macOS
        ["User-Agent", CHROME_UA],
        ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
        ["Sec-Fetch-Site", "none"],
        ["Sec-Fetch-Mode", "navigate"],
        ["Sec-Fetch-Dest", "document"],
        ["Accept-Encoding", "gzip, deflate, br"],
        ["Accept-Language", "en-GB,en;q=0.9"],
      ]),
    ],
  },
  {
    id: "fake-googlebot",
    title: "Forged Googlebot",
    expect: "proven impersonator -> blocked (DNS refutes the claim)",
    ip: "203.0.113.60",
    run: async () => [
      await request("GET", "/", [
        ["User-Agent", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
        ["Accept", "text/html,application/xhtml+xml,*/*;q=0.8"],
        ["Accept-Encoding", "gzip, deflate, br"],
      ]),
    ],
  },
  {
    id: "verified-crawler",
    title: "GPTBot from its published range",
    expect: "verified-bot -> allowed, no challenge, no rate limit",
    // The demo server is configured with crawlerRanges: { gptbot: ["198.51.100.0/24"] }.
    ip: "198.51.100.7",
    run: async () => {
      const headers: Header[] = [
        ["User-Agent", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot"],
        ["Accept", "text/html,application/xhtml+xml,*/*;q=0.8"],
        ["Accept-Encoding", "gzip, deflate"],
      ];
      const replies: Reply[] = [];
      for (const path of ["/", "/products", "/products/3", "/products/4"]) replies.push(await request("GET", path, headers));
      return replies;
    },
  },
  {
    id: "declared-crawler",
    title: "An honest crawler with no way to verify it",
    expect: "declared-bot -> served up to 30/min, then rate-limited. Never blocked.",
    ip: "203.0.113.70",
    run: async () => {
      const headers: Header[] = [
        ["User-Agent", "Mozilla/5.0 (compatible; ExampleNewsBot/1.4; +https://example.com/bot)"],
        ["Accept", "text/html,*/*;q=0.8"],
        ["Accept-Encoding", "gzip"],
      ];
      const replies: Reply[] = [];
      // Past the 30/minute ceiling, so the limit is actually demonstrated rather
      // than merely configured.
      for (let i = 1; i <= 36; i++) replies.push(await request("GET", `/products/${(i % 40) + 1}`, headers));
      return replies;
    },
  },
  {
    id: "trap",
    title: "Following a link no person can see",
    expect: "proven -> blocked, on one request, with no history needed",
    ip: "203.0.113.80",
    run: async () => [
      await request("GET", "/", chrome()),
      await request("GET", "/internal/export.csv", chrome()),
    ],
  },
  {
    id: "trap-field",
    title: "Filling a hidden form field",
    expect: "proven -> blocked",
    ip: "203.0.113.81",
    // The honeypot goes in the body and nowhere else, which is what a form filler
    // actually does. This used to repeat it in the query string as well, and that
    // duplicate was doing all the work: the engine reads no request body, so until the
    // demo started handing its parsed form over the scenario was passing on the query
    // string alone while the field it was meant to exercise went unseen.
    run: async () => [
      await request(
        "POST",
        "/login",
        [...chrome(), ["Content-Type", "application/x-www-form-urlencoded"]],
        "email=a%40b.com&password=hunter2&company_url=http%3A%2F%2Fspam.example",
      ),
    ],
  },
  {
    id: "scraper",
    title: "Enumerating the catalogue",
    expect: "crawl-breadth plus session-integrity -> suspected, challenged",
    ip: "203.0.113.90",
    run: async () => {
      const headers: Header[] = [
        ["User-Agent", CHROME_UA],
        ["Accept", "*/*"],
        ["Accept-Encoding", "gzip, deflate"],
      ];
      const replies: Reply[] = [];
      for (let id = 1; id <= 34; id++) {
        replies.push(await request("GET", `/products/${id}`, headers));
        await sleep(15);
      }
      return replies;
    },
  },
  {
    id: "metronome",
    title: "A polite scraper pacing itself under the rate limit",
    expect: "cadence notices the rhythm that rate counting cannot",
    ip: "203.0.113.91",
    run: async () => {
      const replies: Reply[] = [];
      for (let i = 0; i < 14; i++) {
        replies.push(await request("GET", `/search?q=term${i}`, chrome()));
        // Machine-perfect spacing: the coefficient of variation goes to nearly zero.
        await sleep(200);
      }
      return replies;
    },
  },
  {
    id: "burst",
    title: "A flood from one address",
    expect: "rate-anomaly reports it — and is capped at moderate, so it cannot block",
    ip: "203.0.113.92",
    run: async () => {
      const replies: Reply[] = [];
      for (let i = 0; i < 30; i++) replies.push(await request("GET", `/products/${(i % 40) + 1}`, chrome()));
      return replies;
    },
  },
  {
    id: "credential-stuffing",
    title: "Working through a password list",
    expect: "every attempt delayed 250ms — watch the average latency below",
    ip: "203.0.113.93",
    run: async () => {
      const replies: Reply[] = [];
      // Browser-shaped on purpose. A stuffer sending `python-requests` is proven
      // automation and gets challenged long before any of this matters; the
      // interesting case is the one that looks ordinary, where a uniform delay is
      // the only response that costs a real person nothing.
      for (let i = 0; i < 8; i++) {
        replies.push(
          await request(
            "POST",
            "/login",
            [...chrome(), ["Content-Type", "application/x-www-form-urlencoded"], ["Origin", `http://${HOST}:${PORT}`]],
            `email=victim%40example.com&password=guess${i}`,
          ),
        );
      }
      return replies;
    },
  },
  {
    id: "no-user-agent",
    title: "No User-Agent at all",
    expect: "moderate only — stripped headers happen to real people too",
    ip: "203.0.113.94",
    run: async () => [await request("GET", "/", [["Accept", "*/*"]])],
  },
];

// ---------------------------------------------------------------------------

function meanMs(replies: Reply[]): string {
  if (replies.length === 0) return "-";
  return `${Math.round(replies.reduce((sum, reply) => sum + reply.ms, 0) / replies.length)}ms`;
}

function summarise(replies: Reply[]): string {
  const byStatus = new Map<number, number>();
  for (const reply of replies) byStatus.set(reply.status, (byStatus.get(reply.status) ?? 0) + 1);
  return [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${count}x ${status === 0 ? "ERR" : status}`)
    .join(", ");
}

function verdicts(replies: Reply[]): string {
  const seen = new Map<string, number>();
  for (const reply of replies) seen.set(reply.verdict, (seen.get(reply.verdict) ?? 0) + 1);
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([verdict, count]) => `${verdict}${count > 1 ? ` x${count}` : ""}`).join(", ");
}

async function reachable(): Promise<boolean> {
  const reply = await request("GET", "/healthz", [["User-Agent", "bothandlerjs-simulator"], ["Accept", "*/*"]]);
  return reply.status === 200;
}

/** `--name value` and `--name=value`, plus bare `--flag`. */
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
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(entry.slice(2), next);
      i++;
    } else {
      flags.set(entry.slice(2), "true");
    }
  }
  return flags;
}

const USAGE = `bot traffic simulator

  npm run simulate                     the eighteen curated scenarios
  npm run simulate <scenario>          one of them
  npm run simulate -- --list           name them all

  npm run simulate -- --corpus         replay the traffic corpus over a real socket
    --audience human                   only people (the ones that must never be denied)
    --tag known-cost                   only cases tagged this way
    --category in-app-webview          only this category
    --case browse-chrome-windows       one case
    --limit 50                         stop after n cases
    --speed 25                         compress the recorded gaps by this factor
    --verbose                          print every case, not only the failures

Corpus replay is the stronger test of the two. The curated scenarios exercise the
demo; the corpus exercises the whole stack — the adapter, Node's header parsing,
whether wire order survives to rawHeaders, cookie parsing, and address resolution
through the forwarding headers. A case that passes in-process and fails here has
found an adapter bug.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  const argument = argv.find((entry) => !entry.startsWith("--")) ?? "all";

  if (flags.has("help") || argument === "help") {
    process.stdout.write(USAGE);
    return;
  }

  if (flags.has("list") || argument === "list") {
    console.log("\nScenarios:\n");
    for (const scenario of SCENARIOS) console.log(`  ${scenario.id.padEnd(20)} ${scenario.title}`);
    console.log(`\n  all                  every scenario above`);
    console.log(`\nOr replay the full traffic corpus:  npm run simulate -- --corpus\n`);
    return;
  }

  if (flags.has("corpus")) {
    if (!(await reachable())) {
      console.error(`\nCannot reach the demo site at ${BASE.origin}.\nStart it first:  npm run demo\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = await replayCorpus(flags);
    return;
  }

  const selected = argument === "all" ? SCENARIOS : SCENARIOS.filter((scenario) => scenario.id === argument);
  if (selected.length === 0) {
    console.error(`Unknown scenario "${argument}". Run \`npm run simulate -- --list\` to see the options.`);
    process.exitCode = 1;
    return;
  }

  if (!(await reachable())) {
    console.error(`\nCannot reach the demo site at ${BASE.origin}.\nStart it first:  npm run demo\n`);
    process.exitCode = 1;
    return;
  }

  const line = "─".repeat(78);
  console.log(`\n${line}`);
  console.log(`  simulating ${selected.length} scenario${selected.length === 1 ? "" : "s"} against ${BASE.origin}`);
  console.log(`  watch it land on the dashboard: http://localhost:${GUI_PORT}/`);
  console.log(line);

  const results: Array<{ scenario: Scenario; replies: Reply[] }> = [];

  for (const scenario of selected) {
    sourceIp = scenario.ip;
    process.stdout.write(`\n  ${scenario.title}\n  ${"·".repeat(scenario.title.length)}\n  from ${scenario.ip} — expecting: ${scenario.expect}\n`);
    const replies = await scenario.run();
    results.push({ scenario, replies });
    console.log(`  ${replies.length} request${replies.length === 1 ? "" : "s"} -> ${summarise(replies)}, avg ${meanMs(replies)}   [${verdicts(replies)}]`);
    // A pause between scenarios so their behavioural windows stay distinct on the
    // dashboard, and so the feed is readable while it fills.
    await sleep(300);
  }

  console.log(`\n${line}`);
  console.log("  summary");
  console.log(line);
  for (const { scenario, replies } of results) {
    console.log(`  ${scenario.id.padEnd(21)} ${summarise(replies).padEnd(20)} ${meanMs(replies).padEnd(8)} ${verdicts(replies)}`);
  }
  const total = results.reduce((sum, entry) => sum + entry.replies.length, 0);
  console.log(`\n  ${total} requests sent. Open http://localhost:${GUI_PORT}/ to see every`);
  console.log(`  assessment, the evidence behind it, and which rules the guard refused to run.\n`);
}

void main();
