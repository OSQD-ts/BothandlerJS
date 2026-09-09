import { ConfigError } from "./config.js";
import { IpRangeSet, parseCidr } from "./internal/ip.js";
import type { BotHandler, ChangeContext } from "./core.js";

/**
 * Published crawler address ranges.
 *
 * Twelve of the signatures in `known-bots.ts` verify by address rather than by reverse
 * DNS — every AI crawler among them — and until this file existed nothing in the
 * library ever filled those ranges in. `updateCrawlerRanges()` was a method waiting for
 * a caller, and `crawler-verification` correctly declined to confirm anybody, because a
 * claim it cannot check is a claim it must not endorse.
 *
 * Verifying by range rather than by reverse DNS is better in three ways where it is
 * available: it is a lookup instead of a network round trip on the request path, it
 * cannot be broken by somebody else's DNS having a bad afternoon, and it works for the
 * several crawlers that publish ranges and no useful `PTR` record at all.
 *
 * **This is opt-in, and it makes outbound requests.** The library otherwise talks to
 * nothing but your own DNS resolver, and a dependency-free package quietly fetching
 * URLs on a timer is not something to inherit by accident.
 *
 * ```ts
 * const stop = startCrawlerRangeRefresh(botHandler, { intervalMs: 12 * 60 * 60_000 });
 * ```
 */

/** One publisher, and where it says its addresses are. */
export interface PublishedRangeSource {
  /** The signature id these ranges belong to. Must match a `BotSignature.id`. */
  id: string;
  /** Where the list is published. HTTPS only — see {@link fetchCrawlerRanges}. */
  url: string;
}

/**
 * The lists shipped with the library, as pointers rather than as data.
 *
 * The distinction matters. This library ships **no address data** and refuses to guess
 * any, because a range baked into a release is a range that is wrong by the time
 * somebody installs it — and being wrong here means either failing to verify a real
 * crawler or, far worse, verifying somebody who has since been handed the address. What
 * it ships is the URL each operator publishes, so the answer always comes from the
 * party entitled to give it.
 *
 * Nothing here is guaranteed to stay reachable. A publisher that moves its file simply
 * stops being verifiable, which is the same position the library was in before, and the
 * refresh says so rather than failing quietly. Pass your own `sources` to add, replace
 * or pin any of it.
 */
export const PUBLISHED_CRAWLER_RANGES: readonly PublishedRangeSource[] = Object.freeze([
  { id: "googlebot", url: "https://developers.google.com/static/search/apis/ipranges/googlebot.json" },
  { id: "google-other", url: "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json" },
  { id: "bingbot", url: "https://www.bing.com/toolbox/bingbot.json" },
  { id: "gptbot", url: "https://openai.com/gptbot.json" },
  { id: "oai-searchbot", url: "https://openai.com/searchbot.json" },
  { id: "chatgpt-user", url: "https://openai.com/chatgpt-user.json" },
  { id: "duckduckbot", url: "https://duckduckgo.com/duckduckbot.json" },
]);

export interface RefreshOptions {
  /** Which lists to fetch. Defaults to {@link PUBLISHED_CRAWLER_RANGES}. */
  sources?: readonly PublishedRangeSource[];
  /** How long any one request may take. Default 10 seconds. */
  timeoutMs?: number;
  /**
   * The fetcher. Defaults to the global `fetch`.
   *
   * Injectable because a test must not reach the internet, and because some
   * deployments only reach the outside world through a proxy they configure
   * themselves.
   */
  fetch?: typeof globalThis.fetch;
  /** Attributed on the `range-change` event, like any other runtime change. */
  by?: string;
}

export interface RefreshResult {
  updated: Array<{ id: string; prefixes: number }>;
  /** Sources that could not be used, and why. Never throws — see below. */
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Largest block a published list may contain.
 *
 * A range here does not merely describe a crawler, it **verifies** one: an address
 * inside it is a `verified-bot`, which most policies allow. So a list that arrived
 * wrong — a parse gone astray, a publisher's mistake, a proxy serving something else
 * entirely — would hand verified status to whatever it covered. `0.0.0.0/0` is the
 * catastrophic version and these bounds stop the whole family: no crawler publishes a
 * block larger than this, so refusing them costs nothing real.
 */
const MAX_V4_BLOCK = 8;
const MAX_V6_BLOCK = 19;
/** A published list is hundreds of prefixes. Ten thousand is somebody else's file. */
const MAX_PREFIXES = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Fetches one published list and returns the prefixes in it.
 *
 * Two formats, because those are the two anybody publishes: a JSON document with a
 * `prefixes` array of `{ ipv4Prefix }` / `{ ipv6Prefix }` objects, which is what Google
 * standardised and what the AI crawlers copied; and a plain-text list of one address or
 * CIDR per line, which is what the older monitoring services publish. Anything else is
 * an error rather than a guess.
 */
export async function fetchCrawlerRanges(source: PublishedRangeSource, options: RefreshOptions = {}): Promise<string[]> {
  return fetchPrefixes(source, options, { maxPrefixes: MAX_PREFIXES, subject: `a crawler's address list`, id: source.id });
}

/** Where a reputation or hosting-provider address list is published. */
export interface AddressListSource {
  /** The range set to install it as. `denylist` blocks; `datacenter` corroborates. */
  id: "denylist" | "datacenter" | "allowlist";
  url: string;
}

export interface AddressListOptions extends RefreshOptions {
  /** Entries to accept before refusing the list. Default 100,000. */
  maxPrefixes?: number;
}

/**
 * Fetches a published address list — a reputation feed, a hosting provider's own ranges.
 *
 * The same hardened path as {@link fetchCrawlerRanges}: HTTPS only, a size cap, comments
 * stripped, JSON `prefixes` documents or one prefix per line, and a list that is empty,
 * oversized or contains a block big enough to matter is refused **whole** rather than in
 * part. It is a separate entry point because the limits differ — a reputation feed is
 * thousands of entries where a crawler's is hundreds, and calling one a crawler's list in
 * an error message helps nobody.
 *
 * It does not install anything. Hand the result to `updateRanges("denylist", …)` when you
 * are ready, which is the same two-step the crawler path takes and for the same reason:
 * fetching is the part that can fail, and installing is the part that changes behaviour.
 *
 * **A denylist entry is `certain`.** It does not corroborate anything — it decides, and it
 * blocks people. A feed is somebody else's judgement about an address, refreshed on
 * somebody else's schedule, and an address that was a bot last month may be a customer's
 * home connection this month. Read what you are subscribing to, and prefer `datacenter`
 * for anything you have not decided about yourself.
 */
export async function fetchAddressList(source: AddressListSource, options: AddressListOptions = {}): Promise<string[]> {
  return fetchPrefixes(source, options, { maxPrefixes: options.maxPrefixes ?? 100_000, subject: "an address list", id: source.id });
}

async function fetchPrefixes(
  source: { id: string; url: string },
  options: RefreshOptions,
  limits: { maxPrefixes: number; subject: string; id: string },
): Promise<string[]> {
  const url = new URL(source.url);
  // Plain HTTP would let anything between here and the publisher decide which addresses
  // this library treats as verified crawlers.
  if (url.protocol !== "https:") throw new ConfigError(`Crawler ranges must be published over HTTPS. "${source.url}" is not.`);

  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new ConfigError("No `fetch` available. Pass one in `fetch`, or run on Node 20 or later.");

  const response = await fetcher(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    headers: { accept: "application/json, text/plain", "user-agent": "bothandlerjs" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

  const text = await readCapped(response);

  const prefixes = text.trimStart().startsWith("{") ? fromJson(text) : fromLines(text);
  return validate(prefixes, limits);
}

/**
 * The body, or as much of it as a list of prefixes could possibly be.
 *
 * `await response.text()` reads to the end before anything can object, so checking the
 * size afterwards decides whether to *use* an oversized list without ever declining to
 * *hold* one: a publisher that started sending gigabytes — compromised, misconfigured,
 * or pointed somewhere else by an operator's typo — would be met with the whole thing
 * in memory and a polite error afterwards. Reading in chunks against a running total
 * stops at the point the answer is already known.
 *
 * `content-length` is checked first when it is offered, which turns the common case
 * into no read at all. It is a claim rather than a fact, so it can only reject early;
 * the running total is what actually holds.
 */
async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(`the list declares ${Math.round(declared / 1024)} kB, which is not a list of prefixes`);
  }

  // A custom `fetch` may hand back a Response without a readable body. Falling back
  // keeps the cap meaningful rather than absent, just later than it would otherwise be.
  const body = response.body;
  if (body === null || body === undefined || typeof body.getReader !== "function") {
    const whole = await response.text();
    if (whole.length > MAX_BYTES) throw new Error(`the list is ${Math.round(whole.length / 1024)} kB, which is not a list of prefixes`);
    return whole;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        throw new Error(`the list is over ${Math.round(MAX_BYTES / 1024)} kB, which is not a list of prefixes`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releasing the lock lets the connection be torn down rather than left half-read.
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

function fromJson(text: string): string[] {
  const document = JSON.parse(text) as { prefixes?: Array<Record<string, unknown>> };
  if (!Array.isArray(document.prefixes)) throw new Error("no `prefixes` array in the document");
  const out: string[] = [];
  for (const entry of document.prefixes) {
    const value = entry["ipv4Prefix"] ?? entry["ipv6Prefix"] ?? entry["ip_prefix"] ?? entry["ipv6_prefix"];
    if (typeof value === "string") out.push(value.trim());
  }
  return out;
}

function fromLines(text: string): string[] {
  return text
    .split("\n")
    // Both comment markers. Crawler lists use `#`; the reputation feeds use `;` — Spamhaus
    // DROP puts its whole header and every per-entry note behind one — and a parser that
    // knows only about `#` reads those as addresses and then drops them as unparseable,
    // which looks identical to a feed that half-arrived.
    .map((line) => (line.split("#")[0] ?? "").split(";")[0]?.trim() ?? "")
    .filter((line) => line !== "");
}

/**
 * Everything a list has to be before it is allowed to verify anybody.
 *
 * Unparseable entries are dropped rather than fatal — a publisher adding a comment line
 * or a trailing blank should not cost you the other four hundred prefixes — but a list
 * that is *empty*, oversized, or contains a block big enough to matter is refused
 * whole. Partial trust is the wrong shape for this: the operation replaces a set, and a
 * set that half-arrived is worse than the one already installed.
 */
function validate(prefixes: readonly string[], limits: { maxPrefixes: number; subject: string; id: string }): string[] {
  if (prefixes.length === 0) throw new Error("the list is empty");
  if (prefixes.length > limits.maxPrefixes) throw new Error(`${prefixes.length} prefixes is not ${limits.subject}`);

  const accepted: string[] = [];
  for (const prefix of prefixes) {
    const cidr = parseCidr(prefix);
    if (cidr === undefined || cidr === null) continue;
    const isV4 = cidr.bytes.length === 4;
    if (cidr.prefix < (isV4 ? MAX_V4_BLOCK : MAX_V6_BLOCK)) {
      throw new Error(`"${prefix}" covers more of the internet than any published list should — refusing the whole list rather than acting on it`);
    }
    accepted.push(prefix);
  }
  if (accepted.length === 0) throw new Error(`nothing in the list parsed as an address or CIDR (first entry: "${prefixes[0]}")`);
  // A last sanity check through the real thing, so a list that would not have loaded
  // anyway fails here rather than inside the handler.
  const set = new IpRangeSet(accepted);
  if (set.size === 0) throw new Error(`nothing in the list loaded for ${limits.id}`);
  return accepted;
}

/**
 * Fetches every published list and installs it.
 *
 * **Never throws and never partially applies.** Each source is independent: one
 * publisher being down, having moved its file or serving something unrecognisable
 * leaves every other crawler's ranges exactly as they were, and leaves *that* crawler's
 * ranges as they were too. The failure is reported in the result and raised as a
 * warning on the handler, which is where the dashboard's notices panel picks it up.
 *
 * That is the same fail-open rule the rest of the library follows: an outage in
 * something the detection consults must degrade detection, never take down the site it
 * protects — and here "degrade" means a crawler goes back to being unverifiable, which
 * is exactly the state it was in before this was ever called.
 */
export async function refreshCrawlerRanges(handler: BotHandler, options: RefreshOptions = {}): Promise<RefreshResult> {
  const sources = options.sources ?? PUBLISHED_CRAWLER_RANGES;
  const result: RefreshResult = { updated: [], failed: [] };
  const context: ChangeContext = options.by === undefined ? {} : { by: options.by };

  const fetched = await Promise.all(
    sources.map(async (source) => {
      try {
        return { source, prefixes: await fetchCrawlerRanges(source, options) };
      } catch (error) {
        return { source, reason: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  for (const entry of fetched) {
    if ("reason" in entry) {
      result.failed.push({ id: entry.source.id, reason: entry.reason });
      handler.warn(`Crawler ranges for "${entry.source.id}" could not be refreshed from ${entry.source.url}: ${entry.reason}. The previous ranges are unchanged.`);
      continue;
    }
    handler.updateCrawlerRanges(entry.source.id, entry.prefixes, context);
    result.updated.push({ id: entry.source.id, prefixes: entry.prefixes.length });
  }

  return result;
}

export interface ScheduleOptions extends RefreshOptions {
  /** How often to refresh. Default 12 hours; the minimum is one hour. */
  intervalMs?: number;
  /** Fetch immediately as well as on the interval. Default true. */
  immediate?: boolean;
}

/**
 * Refreshes on a schedule, and returns the way to stop.
 *
 * Twice a day by default, because these lists change on the order of weeks and a
 * library that polls somebody else's endpoint more often than that is being rude with
 * your egress and their bandwidth. The timer is unreferenced, so it never keeps a
 * process alive on its own.
 */
export function startCrawlerRangeRefresh(handler: BotHandler, options: ScheduleOptions = {}): () => void {
  const intervalMs = Math.max(60 * 60_000, options.intervalMs ?? 12 * 60 * 60_000);
  if (options.immediate !== false) void refreshCrawlerRanges(handler, options).catch(() => {});
  const timer = setInterval(() => {
    void refreshCrawlerRanges(handler, options).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
