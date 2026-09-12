import type { Rule } from "./types.js";

/**
 * Said once, so the three rules that decline a bot say the same thing.
 *
 * It points at no `robots.txt`, deliberately. The generated file cannot express
 * "only if verified" — {@link robotsFromRules} reads identities and categories, not
 * verdicts — so for {@link indexersOnly} it stays permissive while the policy does
 * not, and sending a refused crawler to read it would be sending it to be told it
 * is welcome.
 */
const DECLINED = "This site serves search and social crawlers whose identity it can confirm. Other automated requests are declined.\n";

/**
 * Ready-made rule sets.
 *
 * Each is a starting point to read, adapt and own — not a black box. Every rule
 * carries an id, so you can see exactly which one fired in a decision and replace
 * just that one.
 *
 * All of them assume the default `strict` guard, which means even the harshest rule
 * here cannot deny an unproven request. Choose a preset for the *shape* of the policy;
 * the guard decides how far it is allowed to go.
 */

/**
 * Watch and learn. Nothing is ever withheld from anybody.
 *
 * Run this first, for at least a week, on real traffic. Every bot policy that has
 * ever caused an outage was deployed straight to enforcement by someone who was sure
 * they knew what their traffic looked like.
 */
export function monitorOnly(): Rule[] {
  return [
    { id: "verified-crawler-allow", match: { verdict: "verified-bot" }, action: "allow", reason: "Crawler identity confirmed against its operator's DNS or published ranges." },
    { id: "observe-confirmed", match: { certain: true }, action: "log", reason: "Proven automation. Recording only — this policy withholds nothing." },
    { id: "observe-suspected", match: { verdict: "suspected-bot" }, action: "log", reason: "Suspected automation. Recording only." },
  ];
}

/**
 * Sensible defaults for a public content site.
 *
 * Keeps the crawlers that bring traffic, slows the ones that only take it, challenges
 * what is probably automated, and blocks only what has proven itself.
 */
export function protectContent(): Rule[] {
  return [
    { id: "cleared-human-allow", match: { verdict: "human", certain: true }, action: "allow", reason: "Your application asserted this is a person. Nothing below should second-guess that." },
    { id: "verified-crawler-allow", match: { verdict: "verified-bot" }, action: "allow", reason: "Confirmed search or social crawler — the traffic you want." },
    { id: "impersonator-block", match: { botClass: "impersonator", certain: true }, action: "block", params: { status: 403 }, reason: "Forged a verifiable third-party crawler identity. Proven by DNS, not inferred." },
    { id: "scanner-block", match: { botClass: "scanner", certain: true }, action: "block", params: { status: 403 }, reason: "Self-identified security scanner." },
    { id: "trap-block", match: { detector: "trap", certain: true }, action: "block", params: { status: 403 }, reason: "Followed a link no person can reach." },
    { id: "http-client-challenge", match: { botClass: "http-client" }, action: "challenge", reason: "Bare HTTP client. Challenge rather than block: it may well be your own integration." },
    { id: "scraper-ratelimit", match: { botClass: "scraper" }, action: "rate-limit", params: { limit: { max: 60, windowMs: 60_000 } }, reason: "Behaves like bulk extraction. Rate-limited rather than refused." },
    { id: "declared-bot-tag", match: { botClass: "declared-bot" }, action: "tag", reason: "Announced itself honestly. Tagged so downstream can decide." },
    { id: "suspected-challenge", match: { verdict: "suspected-bot", minScore: 70 }, action: "challenge", reason: "Several probabilistic signals agree. A challenge the client can pass on its own." },
    { id: "suspected-tag", match: { verdict: "suspected-bot" }, action: "tag", reason: "Some signal, not enough to act on." },
  ];
}

/**
 * For an application whose value is in its data — pricing, listings, inventory.
 *
 * The distinguishing move is that AI and SEO crawlers are challenged rather than
 * allowed. That is a business decision rather than a security one, and it is exactly
 * the kind of decision that should be a visible rule you can point at.
 */
export function protectData(): Rule[] {
  return [
    { id: "cleared-human-allow", match: { verdict: "human", certain: true }, action: "allow", reason: "Your application asserted this is a person. Nothing below should second-guess that." },
    { id: "search-crawler-allow", match: { verdict: "verified-bot", category: ["search", "social"] }, action: "allow", reason: "Confirmed search or social crawler — keeps your listings findable and your share cards rendering." },
    { id: "ai-crawler-block", match: { category: "ai", certain: true }, action: "block", params: { status: 403, body: "This site does not permit automated collection. See /robots.txt." }, reason: "Self-declared AI crawler. Declined by policy, not by suspicion." },
    { id: "seo-crawler-block", match: { category: "seo", certain: true }, action: "block", params: { status: 403 }, reason: "Self-declared SEO crawler. Declined by policy." },
    { id: "impersonator-block", match: { botClass: "impersonator", certain: true }, action: "block", params: { status: 403 }, reason: "Forged a verifiable crawler identity." },
    { id: "scanner-block", match: { botClass: "scanner", certain: true }, action: "block", params: { status: 403 }, reason: "Self-identified scanner." },
    { id: "trap-block", match: { detector: "trap", certain: true }, action: "block", params: { status: 403 }, reason: "Followed a link no person can reach." },
    // Verdicts, not bare certainty: `{ certain: true }` alone would also match a
    // proven human, and challenging a customer you just vouched for is worse than
    // useless.
    { id: "any-proven-automation-challenge", match: { verdict: ["confirmed-bot", "verified-bot"], certain: true }, action: "challenge", reason: "Proven automation of some kind. Challenged so a legitimate integration can carry on." },
    { id: "suspected-challenge", match: { verdict: "suspected-bot", minScore: 55 }, action: "challenge", reason: "Enough signal to ask the client to prove it runs a browser." },
    { id: "listing-endpoints-ratelimit", match: { path: ["/api/", "/search"], maxScore: 54 }, action: "rate-limit", params: { limit: { max: 120, windowMs: 60_000 } }, reason: "Broad ceiling on the endpoints worth scraping, applied to everyone equally." },
  ];
}

/**
 * For login, signup, password reset, checkout and anything else where automation is
 * expensive to be wrong about in both directions.
 *
 * **Mount this on those routes only.** Applied site-wide it blocks your payment
 * webhooks, your own server-side renderer and every honest crawler you have — all of
 * which are proven automation, which is exactly what this preset refuses. That is
 * correct behaviour on a login form and an outage anywhere else; the traffic corpus
 * catches it, and it is the kind of mistake whose symptom is a support ticket about
 * missing orders three days later.
 *
 * ```ts
 * app.use("/login", botHandler(authDetector));
 * app.use("/checkout", botHandler(authDetector));
 * ```
 *
 * The unusual choice here is `delay` on merely-suspected traffic. A quarter of a
 * second is imperceptible to a person filling in a form and ruinous to a credential
 * stuffer working through a list — and, unlike a challenge, it excludes nobody.
 */
export function protectAuth(): Rule[] {
  return [
    { id: "cleared-allow", match: { verdict: "human", certain: true }, action: "allow", reason: "Your application asserted this is an authenticated person." },
    { id: "proven-bot-block", match: { certain: true, botClass: ["http-client", "automation", "scanner", "impersonator"] }, action: "block", params: { status: 403 }, reason: "Proven automation on an authentication endpoint." },
    { id: "declared-bot-block", match: { certain: true, botClass: "declared-bot" }, action: "block", params: { status: 403 }, reason: "Crawlers have no business on an auth endpoint, however well-behaved." },
    { id: "suspected-challenge", match: { verdict: "suspected-bot", minScore: 60 }, action: "challenge", reason: "Suspected automation on a sensitive endpoint." },
    { id: "everything-else-delay", match: { method: "POST" }, action: "delay", params: { delayMs: 250 }, reason: "A uniform quarter-second on every credential submission. Imperceptible to a person, and it removes the throughput a stuffing attack depends on." },
  ];
}

/**
 * For a publisher whose problem is being *found*, not being scraped.
 *
 * The distinguishing move is that it allows more than it stops, explicitly and by
 * name. Verified crawlers are allowed ahead of everything; declared benign
 * automation — link unfurlers, feed readers, uptime monitors, the specialist search
 * fleets — is allowed rather than merely tolerated; and the only things refused are
 * the three that are refused everywhere, because they are proven and cannot be
 * anything else.
 *
 * Reach for this when a bot policy has already cost you traffic, or when the site's
 * whole purpose is to be indexed, quoted and shared. The cost is honest: bulk
 * extraction gets rate-limited rather than challenged, so a determined scraper will
 * get your content. On a site that wants to be read, that was always going to be
 * true; what this preset refuses to do is trade away your search traffic to make it
 * slightly less true.
 */
export function allowCrawlers(): Rule[] {
  return [
    { id: "cleared-human-allow", match: { verdict: "human", certain: true }, action: "allow", reason: "Your application asserted this is a person." },
    { id: "verified-crawler-allow", match: { verdict: "verified-bot" }, action: "allow", reason: "Identity confirmed against the operator's DNS or published ranges. This is the traffic that brings you readers." },
    {
      id: "benign-crawler-allow",
      match: { certain: true, category: ["search", "social", "feed", "archive", "monitoring", "advertising"] },
      action: "allow",
      reason: "A self-declared crawler from a category that exists to bring people to you, or to tell you when you are down.",
    },
    { id: "impersonator-block", match: { botClass: "impersonator", certain: true }, action: "block", params: { status: 403 }, reason: "Forged a verifiable third-party crawler identity. Proven by DNS, not inferred." },
    { id: "scanner-block", match: { botClass: "scanner", certain: true }, action: "block", params: { status: 403 }, reason: "Self-identified security scanner." },
    { id: "trap-block", match: { detector: "trap", certain: true }, action: "block", params: { status: 403 }, reason: "Followed a link no person can reach." },
    { id: "scraper-ratelimit", match: { botClass: "scraper" }, action: "rate-limit", params: { limit: { max: 120, windowMs: 60_000 } }, reason: "Bulk extraction, slowed rather than refused." },
    { id: "everything-else-tag", match: {}, action: "tag", reason: "Tagged so your application, cache or edge can decide for itself. Nothing is withheld here." },
  ];
}

/**
 * Keep the search engines. Decline the model trainers.
 *
 * This is the policy question of the moment, and it is a *business* decision rather
 * than a security one — which is exactly the kind of decision this library thinks
 * should be a visible rule you can point at rather than a threshold somebody tuned.
 *
 * The split it draws is the one the AI crawlers themselves publish. A crawler
 * collecting a training corpus and a crawler fetching one page because a person asked
 * a question about it are different jobs, often from the same operator under different
 * product tokens, and a policy that cannot tell them apart either feeds the trainers or
 * breaks the citations. Here the training fleet is declined and everything else is
 * served.
 *
 * **`robots.txt` is the primary mechanism, not this.** The crawlers named here honour
 * it, and a rule that blocks a crawler nobody told is a rule that produces load and no
 * compliance. Generate the file from this policy — `robotsFromRules(declineAiTraining())`
 * — publish it, and treat these rules as what happens to the ones that ignore it.
 */
export function declineAiTraining(): Rule[] {
  return [
    { id: "cleared-human-allow", match: { verdict: "human", certain: true }, action: "allow", reason: "Your application asserted this is a person." },
    { id: "search-crawler-allow", match: { verdict: "verified-bot", category: ["search", "social"] }, action: "allow", reason: "Confirmed search or social crawler — the traffic you are keeping." },
    {
      id: "ai-user-fetch-allow",
      match: { certain: true, identity: ["chatgpt-user", "perplexitybot", "oai-searchbot", "claudebot", "mistral-ai", "duckduckbot"] },
      action: "tag",
      reason: "Fetching one page because a person asked about it, or indexing for a search product. This is a citation, not a corpus — served and tagged.",
    },
    {
      id: "ai-training-block",
      match: { certain: true, category: "ai" },
      action: "block",
      params: { status: 403, body: "This site is not available for automated collection or model training. See /robots.txt.\n" },
      reason: "Self-declared AI crawler collecting at scale. Declined by policy, not by suspicion — and said plainly, so the operator can act on it.",
    },
    { id: "impersonator-block", match: { botClass: "impersonator", certain: true }, action: "block", params: { status: 403 }, reason: "Forged a verifiable crawler identity — including a forged AI crawler, which is what a declined one comes back as." },
    { id: "scanner-block", match: { botClass: "scanner", certain: true }, action: "block", params: { status: 403 }, reason: "Self-identified security scanner." },
    { id: "trap-block", match: { detector: "trap", certain: true }, action: "block", params: { status: 403 }, reason: "Followed a link no person can reach." },
    { id: "unknown-scraper-challenge", match: { botClass: "scraper" }, action: "challenge", reason: "Bulk extraction that declared nothing. A challenge, because an undeclared scraper is exactly the shape of a trainer that stopped announcing itself." },
    { id: "suspected-tag", match: { verdict: "suspected-bot" }, action: "tag", reason: "Some signal, not enough to act on." },
  ];
}

/**
 * For a JSON API rather than a site.
 *
 * One difference drives the whole shape of this preset: **a challenge is useless
 * here.** A proof-of-work interstitial is solved by a browser running JavaScript, and
 * an API client is not one. Challenging your customers' integrations does not slow an
 * attacker down; it breaks the integrations and leaves the attacker to solve it once
 * in a headless browser. So the escalation ladder is rate limiting, and the terminal
 * actions stay where they always are — on proof.
 *
 * The second difference is about what bot detection is *for* on an API. Your
 * authentication is the control that matters, and it already knows who the caller is.
 * This preset therefore tags everything, so your own handlers can combine a verdict
 * with a key, a plan and a quota; it does not try to be the access control.
 *
 * A bare HTTP client is not suspicious here — it is the normal case, and the rule that
 * challenges one on a content site is deliberately absent.
 */
export function protectApi(): Rule[] {
  return [
    { id: "cleared-allow", match: { verdict: "human", certain: true }, action: "allow", reason: "Your application asserted this caller is a person." },
    { id: "impersonator-block", match: { botClass: "impersonator", certain: true }, action: "block", params: { status: 403 }, reason: "Forged a verifiable third-party identity." },
    { id: "scanner-block", match: { botClass: "scanner", certain: true }, action: "block", params: { status: 403 }, reason: "Self-identified security scanner. An API is what they are looking for." },
    { id: "trap-block", match: { detector: "trap", certain: true }, action: "block", params: { status: 403 }, reason: "Followed a link no person can reach." },
    {
      id: "crawler-ratelimit",
      match: { certain: true, botClass: ["declared-bot", "scraper"] },
      action: "rate-limit",
      params: { limit: { max: 60, windowMs: 60_000 } },
      reason: "A crawler on an API endpoint. Not refused — plenty of these are somebody's honest integration — but held to a rate.",
    },
    {
      id: "suspected-ratelimit",
      match: { verdict: "suspected-bot", minScore: 70 },
      action: "rate-limit",
      params: { limit: { max: 120, windowMs: 60_000 } },
      // Deliberately not a challenge: see the doc comment. This is the rule people
      // copy from a content preset and then wonder why their customers' scripts broke.
      reason: "Several probabilistic signals agree. Rate-limited rather than challenged, because a legitimate API client cannot solve a challenge.",
    },
    { id: "tag-everything", match: {}, action: "tag", reason: "Every request carries its verdict to your handlers, where the API key and the plan are. That is where an API decides things." },
  ];
}

/**
 * Indexers welcome, everything else automated is not.
 *
 * The strictest permanent posture in this file: a crawler is served only when its
 * identity has been *confirmed* against its operator's DNS or published ranges, and
 * only when the job it does is bringing people to the site. Every other proven bot is
 * refused, and suspicion escalates as far as the guard allows.
 *
 * Four things to be clear about before choosing it.
 *
 * **Most indexers cannot be verified at all.** Of the search and social signatures the
 * library ships, twelve publish forward-confirmable DNS — Google, Bing, Yandex, Baidu,
 * Apple, Sogou, Seznam, Naver, PetalBot, Cốc Cốc, Yahoo, Pinterest — and two more
 * (DuckDuckBot, Facebook) are checkable only if you supply `crawlerRanges`. The other
 * twenty-three, Twitterbot, LinkedInBot, Slackbot, Discord, Telegram, WhatsApp,
 * Reddit, Mastodon and Bluesky among them, publish nothing to check a claim against.
 * They can never reach `verified-bot`, so they are refused and your pages stop getting
 * link previews when somebody shares them.
 *
 * That is two rules rather than one — `unverifiable-search-block` and
 * `unverifiable-social-block` — because the two halves are not the same trade and
 * almost nobody wants the same answer to both. An unconfirmable *search* claim is
 * usually something pretending to be a search engine; an unconfirmable *social* claim
 * is usually Slack fetching a title card for a link a colleague pasted. Splitting them
 * means serving link unfurlers at a ceiling is one edit, not a rewritten `match`:
 *
 * ```ts
 * rules: indexersOnly().map((rule) => (rule.id === "unverifiable-social-block" ? { ...rule, action: "rate-limit", params: { limit: { max: 60, windowMs: 60_000 } } } : rule))
 * ```
 *
 * **A mail gateway checking a link is served**, by `email-security-allow`, above every
 * refusal here. These are unconfirmable by construction — none of the four signatures
 * publishes anything to check — so without that rule they land in
 * `proven-automation-block` and are refused. What that costs is not a missing preview:
 * it is a real person told, in their inbox, that the link they were sent could not be
 * verified, moments after somebody asked to reset their password. They were never the
 * one crawling. Delete the rule if your site has no mailed links, but know which way
 * that error falls.
 *
 * **A confirmed crawler outside `search` and `social` is refused too** — the AI
 * crawlers, the SEO tools, the archivers, the uptime monitors, and **your own webhooks,
 * health probes and server-side renderer**. That last group is how this preset breaks
 * your own infrastructure on the first deploy; fifteen of the corpus's thirty-three
 * infrastructure cases are refused by it. Allowlist yours first, by identity or by
 * address, above everything else:
 *
 * ```ts
 * rules: [{ id: "our-renderer", match: { identity: "our-ssr" }, action: "allow" }, ...indexersOnly()]
 * ```
 *
 * **Suspicion is challenged, not blocked**, and no rule here asks otherwise. Under the
 * default `strict` guard a `block` on a probabilistic verdict is downgraded to a
 * challenge anyway, so writing one would express a strictness the engine does not have
 * while reporting a guard stop on every suspicious request. If you want denial on
 * suspicion, say so where it is visible — `falsePositivePolicy: "balanced"`, which
 * additionally demands two independent strong signals — and add the rule that asks:
 *
 * ```ts
 * { id: "high-suspicion-block", match: { verdict: "suspected-bot", minScore: 90 }, action: "block" }
 * ```
 *
 * Some real people will be denied by that. Nothing in this preset does it for you.
 */
export function indexersOnly(): Rule[] {
  return [
    { id: "cleared-human-allow", match: { verdict: "human", certain: true }, action: "allow", reason: "Your application asserted this is a person. Nothing below should second-guess that." },
    {
      id: "verified-indexer-allow",
      // `verified-bot` is only ever reached through forward-confirmed reverse DNS or a
      // published range, so no claim can reach this rule — which is the whole basis on
      // which this policy is willing to serve a bot at all.
      match: { verdict: "verified-bot", category: ["search", "social"] },
      action: "allow",
      reason: "Identity confirmed against the operator's DNS or published ranges, doing the one job this site serves bots for: making it findable.",
    },
    {
      id: "email-security-allow",
      // Above every refusal below, and deliberately not conditioned on verification:
      // not one mail gateway publishes anything a claim could be checked against, so a
      // rule that waited for `verified-bot` would never fire and this would read as
      // protection while refusing every one of them.
      //
      // The claim is therefore forgeable, and this is the one place in this preset that
      // serves a forgeable claim. It is a considered trade: what it hands an impersonator
      // is one datacentre fetch of a URL it already knew, and what refusing costs is a
      // person told their password-reset mail contained a link that could not be verified.
      match: { category: ["email-security"] },
      action: "allow",
      reason: "A mail gateway checking a link on somebody's behalf, moments before they click it. Refusing this is not a missing preview — it is telling a real person their mail was unsafe.",
    },
    { id: "impersonator-block", match: { botClass: "impersonator", certain: true }, action: "block", params: { status: 403 }, reason: "Forged a verifiable third-party crawler identity. Proven by DNS, not inferred." },
    { id: "scanner-block", match: { botClass: "scanner", certain: true }, action: "block", params: { status: 403 }, reason: "Self-identified security scanner." },
    { id: "trap-block", match: { detector: "trap", certain: true }, action: "block", params: { status: 403 }, reason: "Followed a link no person can reach." },
    {
      id: "non-indexing-crawler-block",
      match: { verdict: "verified-bot" },
      action: "block",
      params: { status: 403, body: DECLINED },
      reason: "A confirmed crawler doing something other than indexing. Declined by policy rather than by suspicion — and said plainly, so its operator can act on it.",
    },
    {
      id: "unverifiable-search-block",
      // Split from the social half below, which used to share this rule. They are not the
      // same trade: an unconfirmable *search* claim is usually something wearing a search
      // engine's name, because the real ones — all twelve that matter — publish DNS you
      // can check. Little of value is lost by refusing this one.
      match: { verdict: "confirmed-bot", category: ["search"] },
      action: "block",
      params: { status: 403, body: DECLINED },
      reason: "Says it indexes, and publishes nothing anyone could check that against. This policy serves crawlers it can confirm, and this claim cannot be confirmed.",
    },
    {
      id: "unverifiable-social-block",
      // The rule to reach for first when this preset costs you something you wanted.
      // Twitter, LinkedIn, Slack, Discord, Telegram, WhatsApp, Reddit, Mastodon and
      // Bluesky publish nothing to check against, so this refuses all of them and your
      // links stop unfurling. `rate-limit` serves them at a ceiling instead; the reason a
      // forged Slackbot is cheap to send is exactly the reason a ceiling is the answer.
      match: { verdict: "confirmed-bot", category: ["social"] },
      action: "block",
      params: { status: 403, body: DECLINED },
      reason: "Says it previews links for a social platform, and publishes nothing anyone could check that against. This policy serves crawlers it can confirm.",
    },
    {
      id: "proven-automation-block",
      match: { verdict: "confirmed-bot", certain: true },
      action: "block",
      params: { status: 403, body: DECLINED },
      reason: "Proven automation that is not a confirmed indexer. A declaration, a contradiction or a trap — never a score.",
    },
    {
      id: "persistent-refuser-ratelimit",
      // Ahead of the challenge rule on purpose: a fourth challenge to something that
      // answered none of the first three achieves nothing but latency.
      match: { minUnsolvedChallenges: 3 },
      action: "rate-limit",
      params: { limit: { max: 10, windowMs: 60_000 } },
      reason: "Three challenges issued and none answered. Held to a rate rather than asked again; solving one clears the count.",
    },
    { id: "suspected-challenge", match: { verdict: "suspected-bot" }, action: "challenge", reason: "Suspicion, at this site's threshold. A challenge is as far as unproven evidence may go, and the client can pass it on its own." },
    {
      id: "weak-suspicion-ratelimit",
      match: { verdict: "unknown", minScore: 40 },
      action: "rate-limit",
      params: { limit: { max: 60, windowMs: 60_000 } },
      reason: "Some signal, below the bar for calling it a bot at all. A ceiling rather than a challenge: it costs a person nothing and costs bulk automation everything.",
    },
    { id: "everything-else-tag", match: {}, action: "tag", reason: "Nothing withheld, and the verdict travels to your handlers so they can decide for themselves." },
  ];
}

/**
 * For while it is happening.
 *
 * A deliberately impatient posture for an incident: a scrape in progress, a stuffing
 * run, a scanner sweeping the range. Everything proven is refused, everything
 * suspected is challenged at a much lower bar than usual, and *everyone* — including
 * the people — is rate-limited, because a uniform ceiling is the one mitigation that
 * cannot single anybody out.
 *
 * Three things to be clear about before turning it on.
 *
 * **It is temporary.** Nothing here is a good permanent policy: the low challenge
 * threshold will interrupt real people on unusual browsers, and the uniform rate limit
 * will interrupt your keenest readers. Turn it on during an incident, turn it off
 * afterwards, and put it behind a switch you can flip without a deploy —
 * `updatePolicy()` and the dashboard's editor exist for exactly this.
 *
 * **It still cannot deny anyone on a guess.** The guard applies here as everywhere
 * else: the `challenge` on suspicion is a challenge because that is as far as
 * unproven evidence may go, and asking for a block instead would simply be refused
 * and recorded. An incident is precisely when people reach for `falsePositivePolicy:
 * "aggressive"`, and precisely when the population getting caught is at its most
 * unusual.
 *
 * **It is not DDoS protection.** This runs inside your process, after the connection
 * has been accepted. Volume that hurts you at the network layer needs handling at the
 * network layer; what this reduces is the *usefulness* of the traffic to whoever is
 * sending it.
 *
 * And one practical warning the traffic corpus makes concrete: like `protect-auth`,
 * this refuses proven automation, so **your own webhooks, health probes and
 * server-side renderer are refused too** — thirteen of the corpus's infrastructure
 * cases are, under this policy. Allowlist their addresses *before* you switch it on,
 * not during the incident when you notice.
 */
export function underAttack(): Rule[] {
  return [
    { id: "cleared-human-allow", match: { verdict: "human", certain: true }, action: "allow", reason: "Your application vouched for this person. Even now, that comes first." },
    { id: "verified-crawler-allow", match: { verdict: "verified-bot" }, action: "allow", reason: "A confirmed crawler is not what is attacking you, and losing your search traffic during an incident makes the incident worse." },
    { id: "impersonator-block", match: { botClass: "impersonator", certain: true }, action: "block", params: { status: 403 }, reason: "Forged a verifiable crawler identity." },
    { id: "scanner-block", match: { botClass: "scanner", certain: true }, action: "block", params: { status: 403 }, reason: "Self-identified security scanner." },
    { id: "trap-block", match: { detector: "trap", certain: true }, action: "block", params: { status: 403 }, reason: "Followed a link no person can reach." },
    { id: "proven-automation-block", match: { verdict: "confirmed-bot", certain: true }, action: "block", params: { status: 403 }, reason: "Proven automation of some kind. During an incident, a declaration is enough." },
    {
      id: "suspected-challenge",
      match: { verdict: "suspected-bot", minScore: 40 },
      action: "challenge",
      reason: "A much lower bar than usual, and still a challenge rather than a block — the client can pass it on its own, which is what makes lowering the bar survivable.",
    },
    {
      id: "everyone-ratelimit",
      match: {},
      action: "rate-limit",
      params: { limit: { max: 30, windowMs: 60_000 } },
      reason: "A ceiling that applies to everybody equally, which is the only mitigation that cannot be wrong about who somebody is.",
    },
  ];
}

/** Every preset by name, for config-driven setups. */
export const PRESETS = {
  "monitor-only": monitorOnly,
  "allow-crawlers": allowCrawlers,
  "protect-content": protectContent,
  "decline-ai-training": declineAiTraining,
  "protect-data": protectData,
  "protect-api": protectApi,
  "protect-auth": protectAuth,
  "indexers-only": indexersOnly,
  "under-attack": underAttack,
} as const;

export type PresetName = keyof typeof PRESETS;
