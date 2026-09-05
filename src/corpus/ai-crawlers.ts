import { plain } from "./headers.js";
import { bot } from "./schema.js";
import { IN_RANGE, OUT_OF_RANGE } from "./ranges.js";
import type { TrafficCase } from "./schema.js";

/**
 * The AI fleet.
 *
 * Every vendor runs several bots with different jobs, and the distinction is the
 * whole point: a **training** crawler collects content for a future model, a
 * **search** crawler indexes pages so an assistant can cite them, and a **user** agent
 * fetches one page because somebody just asked about it. Those are three different
 * bargains. A publisher may well want to decline training, keep search — being cited
 * is traffic — and think carefully about user agents, which are arguably a person
 * with a tool rather than a bot at all.
 *
 * The library's job is to name them precisely enough that the policy can make that
 * distinction. Whether to serve them is a business decision, and the corpus takes no
 * position on it — every case here expects correct *identification*, not a particular
 * action.
 *
 * By 2026 this is the fastest-growing segment of automated traffic: training crawlers
 * fell from 90% to 74% of AI-driven requests over 2025 while scrapers rose to 24%,
 * and a new agentic category appeared. Every one of these declares itself honestly,
 * which is the only reason a rule matching them works at all.
 */

function ai(id: string, title: string, userAgent: string, identity: string, provenance: string, notes?: string): TrafficCase {
  return bot({
    id,
    title,
    audience: "declared-bot",
    category: "ai-crawler",
    provenance,
    ...(notes !== undefined ? { notes } : {}),
    requests: [plain(userAgent)],
    expect: { verdict: "confirmed-bot", certain: true, identity, detectors: ["self-identified"] },
  });
}

export const AI_CRAWLER_CASES: TrafficCase[] = [
  // --- OpenAI's three ---------------------------------------------------------
  bot({
    id: "gptbot-in-range",
    requires: ["crawler-ranges"],
    title: "GPTBot from OpenAI's published range",
    audience: "declared-bot",
    category: "ai-crawler",
    provenance: "OpenAI publishes its crawler ranges at platform.openai.com/docs/bots",
    notes: "Training crawler. Confirmable only because the ranges were supplied — with none configured this is an unverifiable claim, which is the next case.",
    requests: [{ ...plain("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot"), ip: IN_RANGE["gptbot"]! }],
    expect: { verdict: "verified-bot", certain: true, identity: "gptbot", detectors: ["crawler-verification"] },
    tags: ["verification"],
  }),
  bot({
    id: "amazonbot-no-ranges-configured",
    title: "Amazonbot when no ranges have been configured for it",
    audience: "declared-bot",
    category: "ai-crawler",
    provenance: "The library ships no address data; a claim it cannot check is left unchecked",
    notes:
      "The third outcome, and the one most easily got wrong. Unverifiable is not the same as false: with no published list to compare against, the claim stands on its own honesty and the crawler is neither confirmed nor accused.",
    requests: [{ ...plain("Mozilla/5.0 (Linux; Android 6.0.1;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)"), ip: "203.0.113.77" }],
    expect: { verdict: "confirmed-bot", botClass: "declared-bot", certain: true, identity: "amazonbot", notDetectors: ["crawler-verification"] },
    tags: ["verification"],
  }),
  bot({
    id: "gptbot-forged",
    requires: ["crawler-ranges"],
    title: "A forged GPTBot from outside the published range",
    audience: "hostile",
    category: "ai-crawler",
    provenance: "Claiming a crawler identity is the cheapest way to ask for privileged treatment",
    notes: "Proven false, not merely suspected: the operator publishes the exhaustive list and this address is not on it.",
    requests: [{ ...plain("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot"), ip: OUT_OF_RANGE }],
    expect: { verdict: "confirmed-bot", botClass: "impersonator", certain: true, identity: "gptbot" },
    tags: ["verification", "impersonation"],
  }),
  ai("oai-searchbot", "OAI-SearchBot", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", "oai-searchbot", "Search indexing for ChatGPT citations — declining this removes you from answers", "Distinct from GPTBot. Blocking both when you meant to block training is a common and costly mistake."),
  ai("chatgpt-user", "ChatGPT-User", "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)", "chatgpt-user", "Fetches a page because a user asked about it, in real time", "Arguably a person holding a tool rather than a crawler. Rate-limiting it is reasonable; blocking it denies a reader."),

  // --- Anthropic --------------------------------------------------------------
  bot({
    id: "claudebot-in-range",
    requires: ["crawler-ranges"],
    title: "ClaudeBot from its published range",
    audience: "declared-bot",
    category: "ai-crawler",
    provenance: "Anthropic documents its crawlers and publishes ranges",
    requests: [{ ...plain("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"), ip: IN_RANGE["claudebot"]! }],
    expect: { verdict: "verified-bot", certain: true, identity: "claudebot" },
    tags: ["verification"],
  }),
  ai("claude-user", "Claude-User", "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)", "claudebot", "Fetches a page on a user's behalf during a conversation"),
  ai("claude-searchbot", "Claude-SearchBot", "Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)", "claudebot", "Indexes pages so Claude can cite them"),

  // --- The rest ---------------------------------------------------------------
  bot({
    id: "perplexitybot-in-range",
    requires: ["crawler-ranges"],
    title: "PerplexityBot from its published range",
    audience: "declared-bot",
    category: "ai-crawler",
    provenance: "Perplexity publishes ranges for its indexing crawler",
    requests: [{ ...plain("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot"), ip: IN_RANGE["perplexitybot"]! }],
    expect: { verdict: "verified-bot", certain: true, identity: "perplexitybot" },
    tags: ["verification"],
  }),
  ai("perplexity-user", "Perplexity-User", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Perplexity-User/1.0; +https://perplexity.ai/perplexity-user", "perplexitybot", "Real-time fetch on a user's request"),
  ai("google-extended", "Google-Extended", "Mozilla/5.0 (compatible; Google-Extended/1.0)", "google-extended", "A robots.txt token controlling Gemini training, not a separate crawler — declining it does not affect Search ranking", "Worth understanding: this is a *policy token* Google honours, not a distinct fetcher. Confusing it with Googlebot loses your search traffic for nothing."),
  ai("applebot-extended", "Applebot-Extended", "Mozilla/5.0 (compatible; Applebot-Extended/0.1; +http://www.apple.com/go/applebot)", "applebot-extended", "Apple's training-opt-out token, paired with Applebot for search"),
  ai("ccbot", "CCBot (Common Crawl)", "CCBot/2.0 (https://commoncrawl.org/faq/)", "ccbot", "Feeds the Common Crawl corpus, which most open models were trained on"),
  ai("meta-externalagent", "Meta-ExternalAgent", "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "meta-ai", "Meta's AI training crawler, separate from facebookexternalhit"),
  ai("meta-externalfetcher", "Meta-ExternalFetcher", "meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "meta-ai", "Fetches on a user's behalf inside Meta AI"),
  ai("cohere-ai", "Cohere", "cohere-training-data-crawler/1.0 (+https://cohere.com/data-crawler)", "cohere-ai", "Training data collection"),
  ai("diffbot", "Diffbot", "Mozilla/5.0 (compatible; Diffbot/0.1; +http://www.diffbot.com)", "diffbot", "Structured extraction sold as a product — a crawler with mixed robots.txt compliance"),
  ai("ai2bot", "AI2Bot", "Mozilla/5.0 (compatible) AI2Bot (+https://www.allenai.org/crawler)", "ai2bot", "The Allen Institute's research crawler"),
  ai("youbot", "YouBot", "Mozilla/5.0 (compatible; YouBot (+http://www.you.com))", "youbot", "You.com's search and answer crawler"),
  ai("timpibot", "Timpibot", "Mozilla/5.0 (compatible; Timpibot/0.1; +http://www.timpi.io)", "timpibot", "Decentralised index crawler"),

  bot({
    id: "bytespider",
    title: "Bytespider",
    audience: "unwanted-bot",
    category: "ai-crawler",
    provenance: "ByteDance's crawler. Widely reported for aggressive rates and inconsistent robots.txt compliance, and it publishes no vendor documentation page at all.",
    notes:
      "Classified `unwanted-bot` rather than `declared-bot` on its behaviour, not its honesty — it does identify itself. The distinction is a policy judgement the corpus records rather than a technical one.",
    requests: [plain("Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)")],
    expect: { verdict: "confirmed-bot", certain: true, identity: "bytespider" },
  }),

  bot({
    id: "agentic-browser",
    title: "An agentic assistant driving a real browser on a user's behalf",
    audience: "declared-bot",
    category: "ai-agent",
    provenance:
      "The category that appeared during 2025 and grew fastest through 2026: an assistant operating a real browser to complete a task a person asked for. Some announce themselves; this one does.",
    notes:
      "The hardest case in the corpus, and not a technical problem. Every signal says automation, and the honest description is 'a person, using a tool, that happens to be a browser being driven'. The library reports what it sees; whether that should be served is a question about your business, not your logs.",
    requests: [
      plain(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Autonomous-Agent/1.0 (+https://example-agent.ai/bot)",
        [["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Language", "en-US,en;q=0.9"], ["Accept-Encoding", "gzip, deflate, br"]],
      ),
    ],
    expect: { verdict: "confirmed-bot", botClass: "declared-bot", certain: true },
    tags: ["frontier"],
  }),
];
