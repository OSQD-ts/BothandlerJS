import { BOT_SIGNATURES } from "./detectors/known-bots.js";
import { TERMINAL_ACTIONS } from "./policy/types.js";
import type { BotCategory, BotSignature } from "./detectors/known-bots.js";
import type { MatchSpec, Rule } from "./policy/types.js";

/**
 * Generating `robots.txt` from what your policy actually does.
 *
 * Declining a crawler and not saying so is the worst of both worlds: the crawler
 * keeps coming, wastes your bandwidth discovering it is unwelcome on every request,
 * and you get no credit for having a policy. `robots.txt` is where you say it — and
 * for the well-behaved crawlers, saying it is the *only* thing you need to do, since
 * they will simply stop.
 *
 * Two things this file will not pretend. `robots.txt` is a request, not enforcement;
 * everything that ignores it is exactly the population this library exists for. And a
 * generated file can only reflect rules it can *read* — see {@link robotsFromRules}.
 */

export interface RobotsOptions {
  /** Signature ids to disallow entirely, e.g. `["gptbot", "ccbot"]`. */
  disallowBots?: readonly string[];
  /** Whole categories to disallow, e.g. `["ai", "seo"]`. */
  disallowCategories?: readonly BotCategory[];
  /** Paths disallowed for every crawler. Put your trap paths here. */
  disallowPaths?: readonly string[];
  /** Paths explicitly allowed for every crawler, evaluated ahead of the disallows. */
  allowPaths?: readonly string[];
  /** `Sitemap:` lines. Absolute URLs, per the specification. */
  sitemap?: string | readonly string[];
  /** `Crawl-delay:` in seconds for the wildcard group. Not honoured by every crawler. */
  crawlDelay?: number;
  /** Signature database to resolve ids and categories against. */
  signatures?: readonly BotSignature[];
  /** Lines added verbatim at the top, each already comment-prefixed if you want comments. */
  header?: readonly string[];
}

/**
 * Renders a `robots.txt`.
 *
 * Group ordering follows RFC 9309: a crawler obeys the most specific group that names
 * it and ignores every other, so the per-agent groups must repeat any global path
 * rules that should still apply to them. That is handled here — forgetting it is the
 * classic way a `robots.txt` accidentally *un*-blocks a trap path for exactly the
 * crawlers you were most careful about.
 */
export function generateRobotsTxt(options: RobotsOptions = {}): string {
  const signatures = options.signatures ?? BOT_SIGNATURES;
  const byId = new Map(signatures.map((signature) => [signature.id, signature]));

  const declined = new Map<string, BotSignature>();
  for (const id of options.disallowBots ?? []) {
    const signature = byId.get(id);
    if (signature) declined.set(signature.id, signature);
  }
  const categories = new Set(options.disallowCategories ?? []);
  if (categories.size > 0) {
    for (const signature of signatures) {
      if (categories.has(signature.category)) declined.set(signature.id, signature);
    }
  }

  const lines: string[] = [];
  for (const line of options.header ?? []) lines.push(line);
  if (lines.length > 0) lines.push("");

  // Wildcard group first, for readability. Crawlers pick their group by specificity,
  // not by position, so ordering is purely a courtesy to the human reading the file.
  lines.push("User-agent: *");
  for (const path of options.allowPaths ?? []) lines.push(`Allow: ${path}`);
  for (const path of options.disallowPaths ?? []) lines.push(`Disallow: ${path}`);
  if (options.crawlDelay !== undefined) lines.push(`Crawl-delay: ${Math.max(0, Math.round(options.crawlDelay))}`);
  if ((options.allowPaths ?? []).length === 0 && (options.disallowPaths ?? []).length === 0) {
    lines.push("Disallow:");
  }

  for (const signature of [...declined.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push("", `# ${signature.name}${signature.docs ? ` — ${signature.docs}` : ""}`);
    lines.push(`User-agent: ${agentFor(signature)}`);
    // A named group replaces the wildcard group outright for that crawler, so the
    // trap paths have to be repeated here or they would be *permitted* for it.
    for (const path of options.disallowPaths ?? []) lines.push(`Disallow: ${path}`);
    lines.push("Disallow: /");
  }

  const sitemaps = options.sitemap === undefined ? [] : typeof options.sitemap === "string" ? [options.sitemap] : options.sitemap;
  if (sitemaps.length > 0) {
    lines.push("");
    for (const url of sitemaps) lines.push(`Sitemap: ${url}`);
  }

  return `${lines.join("\n")}\n`;
}

/** The `User-agent:` token for a signature. Matching is case-insensitive, so the token works either way. */
export function agentFor(signature: BotSignature): string {
  return signature.robotsAgent ?? signature.tokens[0] ?? signature.id;
}

export interface RobotsFromRulesResult {
  robotsTxt: string;
  /**
   * Every signature id the generated file declines, with categories expanded to the
   * crawlers they cover. Reporting only the explicitly-named ids would say "0
   * declined" for a policy that turns away an entire category.
   */
  declined: string[];
  /**
   * Signature ids a later rule would have declined, but an earlier rule serves.
   *
   * First match wins, so these are *not* in the file. Worth reporting rather than
   * silently omitting: "why is GPTBot in my robots.txt but ChatGPT-User is not" has an
   * answer, and it is your own rule order.
   */
  served: string[];
  /**
   * Rules that could not be read, with the reason.
   *
   * A rule whose `match` is a predicate function is opaque — we can run it, but we
   * cannot ask it which crawlers it is about. Those are listed rather than guessed
   * at, because a `robots.txt` that silently omits something you block is worse than
   * no generated file at all: it tells crawlers they are welcome where they are not.
   */
  unreadable: Array<{ rule: string; reason: string }>;
}

/**
 * Derives a `robots.txt` from the declarative rules in a policy.
 *
 * Reads every rule whose action denies service and whose `match` names an `identity`
 * or a `category`, and declines exactly those crawlers. Rules expressed as predicate
 * functions cannot be introspected and are reported in `unreadable` — check that list
 * before publishing, and add anything it names by hand.
 */
export function robotsFromRules(rules: readonly Rule[], options: RobotsOptions = {}): RobotsFromRulesResult {
  const identities = new Set<string>(options.disallowBots ?? []);
  const categories = new Set<BotCategory>(options.disallowCategories ?? []);
  const unreadable: Array<{ rule: string; reason: string }> = [];

  // Names an earlier rule *serves*. A policy is first-match-wins, so a crawler matched
  // by a non-terminal rule ahead of a category-wide block is not denied — and telling
  // it in `robots.txt` to stay away entirely would be the file contradicting the
  // policy, in the expensive direction. `decline-ai-training` is the case that found
  // this: it serves ChatGPT-User and blocks the rest of the `ai` category, and the
  // generated file told ChatGPT-User to go away.
  const servedIdentities = new Set<string>();
  const servedCategories = new Set<BotCategory>();

  for (const rule of rules) {
    if (!TERMINAL_ACTIONS.has(rule.action)) {
      // Only an unscoped rule serves a crawler across the whole site, which is the
      // only thing a named `robots.txt` group can express.
      if (typeof rule.match !== "function" && rule.match.path === undefined) {
        for (const identity of toArray(rule.match.identity)) servedIdentities.add(identity);
        for (const category of toArray(rule.match.category)) servedCategories.add(category);
      }
      continue;
    }

    if (typeof rule.match === "function") {
      unreadable.push({ rule: rule.id, reason: "the match is a predicate function, which cannot be inspected" });
      continue;
    }

    const spec: MatchSpec = rule.match;
    const named = toArray(spec.identity);
    const inCategories = toArray(spec.category);

    if (named.length === 0 && inCategories.length === 0) {
      unreadable.push({ rule: rule.id, reason: "the match names no identity or category, so which crawlers it covers cannot be determined" });
      continue;
    }

    // A rule scoped to a path denies service *there*, but a named group in a
    // `robots.txt` gets `Disallow: /` — the whole site. Reported rather than passed
    // over in silence, because the direction of the error is the expensive one: a
    // crawler told to stay away entirely stops fetching the pages you wanted indexed,
    // and that shows up weeks later as a ranking drop with nothing in the logs
    // pointing at this file.
    if (spec.path !== undefined) {
      const scoped = toArray(spec.path)
        .map((pattern) => (typeof pattern === "string" ? pattern : String(pattern)))
        .join(", ");
      unreadable.push({
        rule: rule.id,
        reason: `the match is scoped to ${scoped}, but a named group declines a crawler from the whole site — the generated file turns it away more broadly than the policy does`,
      });
    }

    for (const identity of named) identities.add(identity);
    for (const category of inCategories) categories.add(category);
  }

  const signatures = options.signatures ?? BOT_SIGNATURES;
  const expanded = new Set(identities);
  for (const signature of signatures) {
    if (categories.has(signature.category)) expanded.add(signature.id);
  }

  // Subtract what an earlier rule serves, then hand the renderer a fully expanded
  // list: the categories have already been resolved and filtered here, so passing them
  // on would put the exempted crawlers straight back.
  const exempted: string[] = [];
  for (const signature of signatures) {
    if (!expanded.has(signature.id)) continue;
    if (servedIdentities.has(signature.id) || servedCategories.has(signature.category)) {
      expanded.delete(signature.id);
      exempted.push(signature.id);
    }
  }

  const robotsTxt = generateRobotsTxt({ ...options, disallowBots: [...expanded], disallowCategories: [] });
  return { robotsTxt, declined: [...expanded].sort(), unreadable, served: exempted.sort() };
}

function toArray<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}
