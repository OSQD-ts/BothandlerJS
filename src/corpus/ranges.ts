/**
 * Published IP ranges the corpus assumes.
 *
 * Several crawlers publish an exhaustive address list instead of setting PTR records,
 * and the library can only confirm or refute those claims when it has been handed the
 * list. These are the fictional stand-ins the corpus uses, drawn entirely from the
 * documentation ranges reserved by RFC 5737 so that nothing here can ever collide
 * with a real network.
 *
 * The convention, which the cases rely on:
 *
 * - **inside** the range   → the claim is confirmed  → `verified-bot`
 * - **outside** the range  → the claim is refuted    → `impersonator`
 *
 * Cases pick their address to land on the side they mean to test.
 */
export const CORPUS_CRAWLER_RANGES: Readonly<Record<string, readonly string[]>> = {
  // Amazonbot is deliberately absent. Something has to exercise the third outcome —
  // a claim that can be neither confirmed nor refuted because no list was supplied —
  // and that outcome must never look like an accusation.
  gptbot: ["198.51.100.0/25"],
  "oai-searchbot": ["198.51.100.0/25"],
  "chatgpt-user": ["198.51.100.0/25"],
  claudebot: ["198.51.100.128/26"],
  perplexitybot: ["198.51.100.192/27"],
  "meta-ai": ["198.51.100.240/29"],
  "facebook-external": ["198.51.100.240/29"],
  duckduckbot: ["198.51.100.248/30"],
  uptimerobot: ["198.51.100.252/31"],
  pingdom: ["198.51.100.254/32"],
};

/** An address inside a crawler's published range. */
export const IN_RANGE: Readonly<Record<string, string>> = {
  gptbot: "198.51.100.10",
  "oai-searchbot": "198.51.100.11",
  "chatgpt-user": "198.51.100.12",
  claudebot: "198.51.100.130",
  perplexitybot: "198.51.100.194",
  "meta-ai": "198.51.100.241",
  "facebook-external": "198.51.100.242",
  duckduckbot: "198.51.100.249",
  uptimerobot: "198.51.100.252",
  pingdom: "198.51.100.254",
};

/** Outside every published range above — the address a forgery would come from. */
export const OUT_OF_RANGE = "192.0.2.66";

/**
 * Real Googlebot address space, used only as a *shape* for the FCrDNS cases.
 *
 * No lookup ever leaves the process: the runner answers from each case's own `dns`
 * map. The address is realistic so that a reader recognises what is being modelled.
 */
export const GOOGLEBOT_IP = "66.249.66.1";
export const GOOGLEBOT_PTR = "crawl-66-249-66-1.googlebot.com";
export const BINGBOT_IP = "40.77.167.1";
export const BINGBOT_PTR = "msnbot-40-77-167-1.search.msn.com";
