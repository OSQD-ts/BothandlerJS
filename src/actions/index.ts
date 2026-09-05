import type { ActionContext, ActionOutcome, CustomHandler } from "./types.js";
import type { Assessment } from "../types.js";

export type { ActionContext, ActionOutcome, CustomHandler } from "./types.js";

/** Longest header value we will emit. Well past anything useful, short of anything abusive. */
const MAX_HEADER_VALUE = 256;

/**
 * Replaces control characters, then truncates.
 *
 * This is a genuine response-splitting boundary rather than defensive tidying: an
 * evidence summary can quote a User-Agent, so part of what lands in these headers
 * came from the client. Written as a scan over code points rather than a regex so
 * that no control character has to appear in this file's source to be handled.
 */
function headerSafe(value: string): string {
  let output = "";
  for (const character of value.slice(0, MAX_HEADER_VALUE)) {
    const code = character.codePointAt(0) ?? 0;
    output += code < 0x20 || code === 0x7f ? " " : character;
  }
  return output;
}

/**
 * Verdict headers.
 *
 * Separate `X-Bot-*` fields rather than one JSON blob: individual headers survive
 * proxies, land in access logs with no extra configuration, and can be routed on by a
 * CDN or a load balancer without anything having to parse them.
 */
export function verdictHeaders(assessment: Assessment): Record<string, string> {
  const headers: Record<string, string> = {
    "x-bot-verdict": assessment.verdict,
    "x-bot-class": assessment.botClass,
    "x-bot-score": String(assessment.score),
    "x-bot-certain": assessment.certain ? "1" : "0",
    "x-bot-request-id": headerSafe(assessment.requestId),
  };
  if (assessment.identity !== undefined) headers["x-bot-identity"] = headerSafe(assessment.identity);
  const top = assessment.evidence[0];
  if (top) headers["x-bot-reason"] = headerSafe(top.summary);
  return headers;
}

/**
 * Has this client already passed a challenge?
 *
 * Both sources are checked because they fail in opposite directions. The clearance
 * evidence is authoritative — it comes from verifying the client's signed cookie —
 * but the detector only runs when a challenge service is configured. The registry
 * flag survives a missing cookie but not a restart or an LRU eviction. Either one
 * being true is enough to know that re-challenging is pointless.
 */
function alreadyCleared(assessment: Assessment): boolean {
  if (assessment.actor.cleared) return true;
  return assessment.humanEvidence.some((item) => item.detector === "clearance");
}

const DEFAULT_BLOCK_BODY = "This request was identified as automated and has not been served.\nIf you believe this is a mistake, please contact the site operator.\n";

/**
 * Turns a decision into an outcome.
 *
 * Every branch fails towards serving the request. An unconfigured challenge, a store
 * that will not answer, a custom handler that was never registered: each of those is
 * a misconfiguration on our side, and the visitor should not pay for it. The warning
 * goes to the operator; the client gets its page.
 */
export async function executeAction(context: ActionContext): Promise<ActionOutcome> {
  const { assessment, decision } = context;
  const params = decision.params;
  const tags = verdictHeaders(assessment);
  const extra = params.headers ?? {};

  const passThrough = (delayMs?: number): ActionOutcome => ({
    kind: "continue",
    requestHeaders: tags,
    ...(context.exposeVerdictHeaders
      ? { responseHeaders: { ...tags, ...extra } }
      : Object.keys(extra).length > 0
        ? { responseHeaders: extra }
        : {}),
    ...(delayMs !== undefined && delayMs > 0 ? { delayMs } : {}),
  });

  switch (decision.action) {
    case "allow":
      // Through `passThrough` like every other non-terminal action, so that a rule's
      // `params.headers` is honoured here too. Handling `allow` separately meant those
      // headers were accepted, stored and silently dropped — configuration that looks
      // applied and is not. With nothing configured this returns exactly what the
      // special case did.
      return passThrough();

    case "log":
    case "tag":
      return passThrough();

    case "delay":
      // Capped. A long hold is an availability problem for you, not for the client:
      // the connection, the socket and the worker holding them are all yours.
      return passThrough(Math.min(params.delayMs ?? 500, 10_000));

    case "rate-limit": {
      const limit = params.limit ?? { max: 60, windowMs: 60_000 };
      let count: number;
      try {
        count = await context.store.increment(`rl:${assessment.actor.key}`, limit.windowMs);
      } catch {
        context.onWarning("Rate-limit store is unavailable; serving the request. Rate limits are not being enforced.");
        return passThrough();
      }
      if (count <= limit.max) {
        return {
          kind: "continue",
          requestHeaders: tags,
          responseHeaders: {
            ...(context.exposeVerdictHeaders ? tags : {}),
            ...extra,
            "ratelimit-limit": String(limit.max),
            "ratelimit-remaining": String(Math.max(0, limit.max - count)),
          },
        };
      }
      const retryAfter = Math.ceil(limit.windowMs / 1000);
      return {
        kind: "respond",
        status: 429,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": String(retryAfter),
          "ratelimit-limit": String(limit.max),
          "ratelimit-remaining": "0",
          "cache-control": "no-store",
          ...(context.exposeVerdictHeaders ? tags : {}),
          ...extra,
        },
        body: `Rate limit exceeded. Try again in ${retryAfter} seconds.\n`,
      };
    }

    case "challenge": {
      if (!context.challenge) {
        context.onWarning(`Rule "${decision.rule}" asked for a challenge but no challenge secrets are configured. Serving the request and tagging it instead.`);
        return passThrough();
      }

      // Never challenge a client that has already passed one.
      //
      // Without this the action is a livelock generator, and the mechanism is not
      // obvious: a `certain` verdict cannot be undone by passing a challenge, because
      // proven bot evidence outranks the `moderate` human evidence a solved proof of
      // work is worth — deliberately, since a headless browser solves one as readily
      // as a person. So a JavaScript-capable client that a rule challenges on proven
      // evidence solves the puzzle, reloads, is challenged again, and loops forever,
      // burning its CPU and flooding the log.
      //
      // Re-issuing proves nothing that the first pass did not, so the loop cannot
      // even terminate usefully. We break it by serving the request, and tell the
      // operator plainly that their rule is asking for the wrong thing: a verdict
      // that a challenge cannot change wants `allow`, `rate-limit` or `block`.
      if (alreadyCleared(assessment)) {
        context.onWarning(
          `Rule "${decision.rule}" asked to challenge an actor that already holds a valid clearance token ` +
            `(verdict "${assessment.verdict}", ${assessment.certain ? "proven" : `score ${assessment.score}`}). ` +
            `Passing the challenge cannot change a proven verdict, so re-issuing it would loop forever; the request has been served instead. ` +
            `Change this rule to "allow", "rate-limit" or "block" — challenging is only useful where clearance can actually alter the outcome.`,
        );
        return passThrough();
      }

      // The visitor's own header, so the page can be written in a language they read.
      const response = context.challenge.issue(assessment.actor.key, { acceptLanguage: assessment.facts.headers["accept-language"] });
      context.onChallenge?.("issued");
      return {
        kind: "respond",
        status: response.status,
        // The verdict tags belong here too. Every other responding branch honours
        // `exposeVerdictHeaders`, and omitting it on the challenge made the flag mean
        // "on every response except the one a suspected client actually receives" —
        // which is both surprising and the least useful place to leave it out.
        headers: { ...response.headers, ...(context.exposeVerdictHeaders ? tags : {}), ...extra },
        body: response.body,
      };
    }

    case "redirect": {
      const location = params.location;
      if (location === undefined) {
        context.onWarning(`Rule "${decision.rule}" is a redirect with no "location" parameter. Serving the request instead.`);
        return passThrough();
      }
      return {
        kind: "respond",
        status: params.status ?? 302,
        headers: {
          location: headerSafe(location),
          "cache-control": "no-store",
          ...(context.exposeVerdictHeaders ? tags : {}),
          ...extra,
        },
        body: "",
      };
    }

    case "block":
      return {
        kind: "respond",
        status: params.status ?? 403,
        headers: {
          "content-type": params.contentType ?? "text/plain; charset=utf-8",
          "cache-control": "no-store",
          // A refusal must never be indexed or cached as if it were the site's content.
          "x-robots-tag": "noindex, nofollow",
          ...(context.exposeVerdictHeaders ? tags : {}),
          ...extra,
        },
        body: params.body ?? DEFAULT_BLOCK_BODY,
      };

    case "drop":
      return { kind: "drop" };

    case "custom": {
      const handler = params.handler !== undefined ? context.handlers.get(params.handler) : undefined;
      if (!handler) {
        context.onWarning(`Rule "${decision.rule}" names the custom handler "${params.handler ?? "(none)"}", which is not registered. Serving the request instead.`);
        return passThrough();
      }
      try {
        return await handler.execute(context);
      } catch (error) {
        // The one place a third party's code runs inside the request path, and it was
        // the one place not isolated: a handler that threw escaped `handle()` and
        // turned a bot-detection bug into a failed page load. Every other dependency
        // here — detectors, stores, sinks — degrades to serving the request, and a
        // custom action is not a better reason to fail than any of them.
        context.onWarning(
          `Custom handler "${handler.id}" (rule "${decision.rule}") threw: ${error instanceof Error ? error.message : String(error)}. Serving the request instead.`,
        );
        return passThrough();
      }
    }

    default: {
      // Exhaustiveness: adding an action without handling it here becomes a compile
      // error rather than a rule that silently does nothing.
      const exhaustive: never = decision.action;
      context.onWarning(`Unknown action "${String(exhaustive)}"; serving the request.`);
      return passThrough();
    }
  }
}

/** Registers a custom handler, with the types inferred. */
export function defineHandler(handler: CustomHandler): CustomHandler {
  return handler;
}
