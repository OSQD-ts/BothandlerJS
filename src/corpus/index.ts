import { AI_CRAWLER_CASES } from "./ai-crawlers.js";
import { ADVERSARIAL_CASES } from "./adversarial.js";
import { BENIGN_BOT_CASES } from "./benign-bots.js";
import { REGIONAL_CRAWLER_CASES } from "./crawlers-regional.js";
import { VERTICAL_CRAWLER_CASES } from "./crawlers-vertical.js";
import { ADVERTISING_EMAIL_CASES } from "./advertising-email.js";
import { CDN_GATEWAY_CASES } from "./cdn-gateways.js";
import { HUMAN_BROWSER_CASES } from "./humans-browsers.js";
import { HUMAN_APP_CASES } from "./humans-apps.js";
import { HUMAN_CASES } from "./humans.js";
import { INFRASTRUCTURE_CASES } from "./infrastructure.js";
import { REPUTATION_CASES } from "./reputation.js";
import { EXTENDED_LIBRARY_CASES } from "./libraries-extended.js";
import { TOOLING_CASES } from "./tooling.js";
import { UNWANTED_BOT_CASES } from "./unwanted.js";
import type { Audience, TrafficCase } from "./schema.js";

export * from "./schema.js";
export * from "./headers.js";
export * from "./ranges.js";
export { HUMAN_CASES } from "./humans.js";
export { HUMAN_BROWSER_CASES } from "./humans-browsers.js";
export { HUMAN_APP_CASES } from "./humans-apps.js";
export { BENIGN_BOT_CASES } from "./benign-bots.js";
export { REGIONAL_CRAWLER_CASES } from "./crawlers-regional.js";
export { VERTICAL_CRAWLER_CASES } from "./crawlers-vertical.js";
export { ADVERTISING_EMAIL_CASES } from "./advertising-email.js";
export { CDN_GATEWAY_CASES } from "./cdn-gateways.js";
export { AI_CRAWLER_CASES } from "./ai-crawlers.js";
export { UNWANTED_BOT_CASES } from "./unwanted.js";
export { TOOLING_CASES } from "./tooling.js";
export { EXTENDED_LIBRARY_CASES } from "./libraries-extended.js";
export { ADVERSARIAL_CASES } from "./adversarial.js";
export { INFRASTRUCTURE_CASES } from "./infrastructure.js";
export { REPUTATION_CASES } from "./reputation.js";

/**
 * The corpus.
 *
 * Order matters only for readability. Every case carries its own address and its own
 * clock, so no case can influence another — which is what makes it safe to run a
 * subset, or one case on its own while debugging.
 */
export const CORPUS: readonly TrafficCase[] = Object.freeze([
  ...HUMAN_CASES,
  ...HUMAN_BROWSER_CASES,
  ...HUMAN_APP_CASES,
  ...BENIGN_BOT_CASES,
  ...REGIONAL_CRAWLER_CASES,
  ...VERTICAL_CRAWLER_CASES,
  ...ADVERTISING_EMAIL_CASES,
  ...CDN_GATEWAY_CASES,
  ...AI_CRAWLER_CASES,
  ...UNWANTED_BOT_CASES,
  ...TOOLING_CASES,
  ...EXTENDED_LIBRARY_CASES,
  ...ADVERSARIAL_CASES,
  ...INFRASTRUCTURE_CASES,
  ...REPUTATION_CASES,
]);

/** What each audience means, and what being wrong about it costs. */
export const AUDIENCE_STAKES: Readonly<Record<Audience, string>> = {
  human: "A person. Denying one is a customer turned away, and the corpus treats it as a hard failure.",
  "benign-bot": "Automation you want. Denying one costs search ranking, share previews, or a monitor that lies about being green.",
  "declared-bot": "Honest automation. How you treat it is a business decision; the library only has to name it correctly.",
  "unwanted-bot": "Automation most sites decline. Blocking it is safe when — and only when — it declared itself.",
  hostile: "Scanners, forgeries and credential attacks. Denying these is the point.",
  infrastructure: "Your own machinery. Usually belongs in `ignorePaths` or the allowlist rather than in front of a detector.",
};

/** Fails fast on a duplicate id, which would otherwise silently shadow a case in every report. */
export function assertCorpusIntegrity(cases: readonly TrafficCase[] = CORPUS): void {
  const seen = new Map<string, TrafficCase>();
  const problems: string[] = [];

  for (const item of cases) {
    const previous = seen.get(item.id);
    if (previous) problems.push(`duplicate id "${item.id}" (${previous.title} / ${item.title})`);
    seen.set(item.id, item);

    if (item.requests.length === 0) problems.push(`case "${item.id}" has no requests`);
    if (item.provenance.trim().length === 0) problems.push(`case "${item.id}" has no provenance`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id)) problems.push(`case id "${item.id}" is not kebab-case`);
  }

  if (problems.length > 0) throw new Error(`Corpus integrity problems:\n  - ${problems.join("\n  - ")}`);
}

export function casesByAudience(audience: Audience, cases: readonly TrafficCase[] = CORPUS): TrafficCase[] {
  return cases.filter((item) => item.audience === audience);
}

export function casesByTag(tag: string, cases: readonly TrafficCase[] = CORPUS): TrafficCase[] {
  return cases.filter((item) => item.tags?.includes(tag) === true);
}

/** Every distinct category present, for reports that group by it. */
export function categories(cases: readonly TrafficCase[] = CORPUS): string[] {
  return [...new Set(cases.map((item) => item.category))].sort();
}
