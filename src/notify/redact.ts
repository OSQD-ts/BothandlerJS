import { networkKey } from "../internal/ip.js";
import type { Assessment, Evidence } from "../types.js";
import type { BotEvent } from "./types.js";

export interface RedactionOptions {
  /**
   * Replace client addresses with a coarse network (`/24`, `/64`) before the event
   * leaves the process. Default true.
   *
   * On by default because a notification sink is usually a third party — Slack, a
   * webhook, an aggregator — and an IP address is personal data in most of the world.
   * The network is enough to recognise a pattern and to correlate repeat offenders,
   * which is what an alert is for; the exact address is only needed when you are
   * ready to act on one, and that belongs in your own logs.
   */
  maskIp?: boolean;
  /** Drop the full User-Agent, keeping only the parsed shape. Default false. */
  dropUserAgent?: boolean;
  /** Headers never included in an outbound event, whatever else is configured. */
  neverSend?: readonly string[];
  /**
   * Replace query-string *values* with a placeholder, keeping the parameter names.
   * Default true.
   *
   * A query string is where password-reset tokens, invitation links, email addresses
   * and session ids actually live, and it was the one client-supplied structure this
   * module passed through untouched while stripping cookies and credential headers
   * beside it. The names are what make an alert legible — a burst of `?export=` is the
   * pattern worth seeing — and the values are what you do not want in a third party's
   * message history.
   */
  maskQuery?: boolean;
}

const REDACTED = "[redacted]";

/** Always stripped. Each of these carries a credential or a session. */
/**
 * Always stripped, wherever a request is shown to somebody other than the engine.
 *
 * Exported because the dashboard's header inspector needs the same list: a panel that
 * prints the request as it arrived would otherwise print session cookies and bearer
 * tokens onto an operator's screen, and into whatever screenshot they paste into a
 * ticket.
 */
export const CREDENTIAL_HEADERS: readonly string[] = ["cookie", "authorization", "proxy-authorization", "x-api-key", "x-auth-token", "set-cookie"];

const ALWAYS_STRIP = CREDENTIAL_HEADERS;

/**
 * Produces the version of an event that is safe to send somewhere else.
 *
 * This runs on the way *out*, not on the way in: detection sees everything, and only
 * the copy handed to a sink is reduced. Getting that order wrong would trade
 * detection quality for a privacy property you can have for free.
 */
export function redactEvent(event: BotEvent, options: RedactionOptions = {}): BotEvent {
  const maskIp = options.maskIp ?? true;
  const strip = new Set([...ALWAYS_STRIP, ...(options.neverSend ?? []).map((name) => name.toLowerCase())]);

  const settings = { maskIp, strip, dropUserAgent: options.dropUserAgent ?? false, maskQuery: options.maskQuery ?? true };
  // An `anomaly` describes a stretch of time rather than a request, so there is
  // nothing here to reduce: it carries counts and ratios and no client data at all.
  if (event.assessment === undefined) return event;
  const { assessment, removed } = redactAssessment(event.assessment, settings);

  return {
    ...event,
    assessment,
    // A decision's reason quotes the evidence that produced it, so it carries whatever
    // the evidence carried. Redacting the assessment and shipping the sentence
    // describing it would defeat the exercise.
    ...(event.decision !== undefined && removed.length > 0
      ? { decision: { ...event.decision, reason: scrubText(event.decision.reason, removed) } }
      : {}),
  };
}

function redactAssessment(
  assessment: Assessment,
  options: { maskIp: boolean; strip: Set<string>; dropUserAgent: boolean; maskQuery: boolean },
): { assessment: Assessment; removed: string[] } {
  const headers: Record<string, string | undefined> = {};
  /**
   * The values we decided must not leave the process.
   *
   * Removing a header from the map is not the same as removing it from the event.
   * Detectors quote what they saw — `accept-signature` puts the Accept header in its
   * metadata, `client-hints` puts a slice of the User-Agent in its own — so a header
   * stripped here reappeared verbatim a few fields away, and `dropUserAgent` dropped
   * the User-Agent from exactly one of the two places it was written.
   */
  const removed: string[] = [];
  for (const [name, value] of Object.entries(assessment.facts.headers)) {
    if (options.strip.has(name) || (options.dropUserAgent && name === "user-agent")) {
      if (value !== undefined && value.length > 0) removed.push(value);
      continue;
    }
    headers[name] = value;
  }

  return {
    removed,
    assessment: {
      ...assessment,
      actor: options.maskIp ? { ...assessment.actor, key: maskActorKey(assessment.actor.key) } : assessment.actor,
      evidence: scrubEvidence(assessment.evidence, removed),
      humanEvidence: scrubEvidence(assessment.humanEvidence, removed),
      facts: {
        ...assessment.facts,
        ip: options.maskIp ? maskIpValue(assessment.facts.ip) : assessment.facts.ip,
        headers,
        ...(options.maskQuery ? { query: maskQueryValues(assessment.facts.query) } : {}),
        // Cookies are a session in structured form. There is no version of an alert
        // that needs them.
        cookies: undefined,
      },
    },
  };
}

function maskQueryValues(query: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const name of Object.keys(query)) masked[name] = REDACTED;
  return masked;
}

/** Rewrites evidence so nothing stripped from the headers survives in what a detector quoted. */
function scrubEvidence(items: readonly Evidence[], removed: readonly string[]): Evidence[] {
  if (removed.length === 0) return [...items];
  return items.map((item) => {
    const scrubbed: Evidence = { ...item, summary: scrubText(item.summary, removed) };
    if (item.metadata !== undefined) {
      const metadata: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(item.metadata)) {
        metadata[key] = typeof value === "string" ? scrubText(value, removed) : value;
      }
      scrubbed.metadata = metadata;
    }
    return scrubbed;
  });
}

/**
 * Removes any of `removed` from `text`.
 *
 * The containment test runs both ways on purpose. Detectors routinely record a
 * *truncated* copy — `ua.raw.slice(0, 160)` — and searching a 160-character excerpt
 * for the 400-character header it came from finds nothing at all, which is precisely
 * the case where the redaction was needed. Short values are left alone: a two-character
 * header value matches half the English language, and blanking it would destroy the
 * event to protect nothing.
 */
const MIN_SCRUB_LENGTH = 8;

function scrubText(text: string, removed: readonly string[]): string {
  let output = text;
  for (const secret of removed) {
    if (secret.length < MIN_SCRUB_LENGTH) continue;
    if (output.includes(secret)) {
      output = output.split(secret).join(REDACTED);
      continue;
    }
    if (output.length >= MIN_SCRUB_LENGTH && secret.includes(output)) return REDACTED;
  }
  return output;
}

function maskIpValue(ip: string): string {
  return networkKey(ip);
}

function maskActorKey(key: string): string {
  // An actor key may be an address, an address with a suffix, or something else
  // entirely. Mask a leading address if there is one and leave anything else alone.
  const separator = key.indexOf("|");
  if (separator === -1) return networkKey(key);
  return `${networkKey(key.slice(0, separator))}|${key.slice(separator + 1)}`;
}
