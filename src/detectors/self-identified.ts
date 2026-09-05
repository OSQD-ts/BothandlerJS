import { absenceIsMeaningful } from "./types.js";
import type { Detector, DetectionContext } from "./types.js";
import type { BotClass, Evidence } from "../types.js";
import type { BotCategory } from "./known-bots.js";

export interface SelfIdentifiedOptions {
  /**
   * Categories to report. Removing one does not make its traffic invisible — the
   * behavioural detectors still see it — it only stops this detector naming it.
   */
  categories?: readonly BotCategory[];
}

/**
 * The client told us what it is.
 *
 * This detector is the backbone of the `certain` tier, and the reason is a point
 * about responsibility rather than about technology. When a request arrives saying
 * `python-requests/2.31.0` or `Googlebot/2.1`, we are not *inferring* anything. We
 * are taking the client at its word. If that word is a lie, the misclassification is
 * the client's doing, not a failure of detection — and no honest client is ever
 * harmed by being believed.
 *
 * That is why a self-declaration can safely gate a terminal action while a much
 * "smarter" behavioural inference cannot. The behavioural inference can be wrong
 * about someone who never made any claim at all.
 *
 * Two shapes qualify:
 *
 * - A **known signature** — a token from {@link BOT_SIGNATURES}. Library and headless
 *   tokens are conclusive on their own: no browser has ever sent `curl/8.4.0`.
 * - An **unrecognised but self-announcing** UA — contains a word like `bot` or
 *   `crawler` *and* publishes a contact URL or email, the long-standing convention
 *   for well-behaved crawlers. Either half alone is only suggestive; together they
 *   are a declaration.
 */
export function selfIdentifiedDetector(options: SelfIdentifiedOptions = {}): Detector {
  const allowed = options.categories ? new Set(options.categories) : undefined;

  return {
    id: "self-identified",
    description: "The User-Agent names a known bot, a scripting library, or announces itself as a crawler",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const results: Evidence[] = [];

      for (const signature of ctx.signatureMatches) {
        if (allowed && !allowed.has(signature.category)) continue;

        // A signature reaches the `certain` tier only when "no honest client sends
        // this" genuinely holds. Where it does not — an embedded webview shipped
        // inside a desktop app — the match is still worth recording and must not be
        // able to deny anyone service.
        const conclusive = signature.conclusive !== false;

        results.push({
          detector: "self-identified",
          summary: conclusive
            ? `User-Agent identifies ${signature.name}`
            : `User-Agent identifies ${signature.name}, which a person may well be using`,
          direction: "bot",
          certainty: conclusive ? "certain" : "weak",
          ...(conclusive ? {} : { weight: 0.15 }),
          botClass: classFor(signature.category),
          identity: signature.id,
          ...(conclusive
            ? {
                deterministicBasis:
                  signature.category === "library" || signature.category === "headless"
                    ? `The product token "${signature.tokens[0]!}" is emitted by an HTTP library or an automation runtime and by no browser. Nothing a person does in a browser produces it.`
                    : `The client names itself as ${signature.name}. This is a declaration, not an inference: believing a client's own statement about itself cannot misclassify an honest one.`,
              }
            : {}),
          metadata: {
            signatureId: signature.id,
            category: signature.category,
            benign: signature.benign,
            verifiable: signature.verification.kind !== "none",
            ...(signature.caveat ? { caveat: signature.caveat } : {}),
            ...(signature.docs ? { docs: signature.docs } : {}),
          },
        });
      }

      // Unrecognised self-announcement. New crawlers appear constantly and the
      // database will always lag; the convention they follow does not.
      //
      // What reaches `certain` here is narrower than it looks, and it used to be much
      // wider than intended. The rule is *both* halves — automation announced, and an
      // operator named — but the branch was entered on either half and then decided
      // certainty on the contact alone. So a User-Agent that merely contained a URL or
      // an email became a proven bot: `Mozilla/5.0 … Chrome/122 … Notes/3.1
      // (support@notes.example)` is a person using an application that puts its own
      // support address in the string, and it was reported as a client that "describes
      // itself as a crawler" with certainty high enough to deny it service.
      //
      // The `+` convention counts as the announcement in its own right — `+https://…`
      // exists precisely to say "automation, and here is who runs it", which is how a
      // crawler that never uses the word "bot" still declares itself. A bare URL says
      // no such thing.
      if (results.length === 0 && ctx.ua.shape === "declared-bot") {
        // The `+URL` convention announces automation only in a string that is not also
        // a browser. Overcast's iOS app is the case that proves it: the same
        // application fetches podcast feeds *and* opens the links a listener taps, and
        // it sends one User-Agent for both — a complete iOS WebKit string with
        // `+http://overcast.fm/` appended. Treating the convention alone as a
        // declaration reached certainty about a person tapping a link. A rendering
        // engine in the string is what separates an app that also crawls from a
        // crawler; a crawler that means it says so with a word as well.
        const announces = ctx.ua.declaresAutomation || (ctx.ua.usesContactConvention && ctx.ua.engine === undefined);
        const conclusive = announces && ctx.ua.declaresContact;

        if (conclusive) {
          results.push({
            detector: "self-identified",
            summary: "User-Agent announces itself as automated and publishes an operator contact",
            direction: "bot",
            certainty: "certain",
            botClass: "declared-bot",
            deterministicBasis:
              "The client both describes itself as automated and publishes an operator contact, the convention followed by crawlers that expect to be identified. Taken together these are a declaration of intent, not a guess about behaviour.",
            metadata: { userAgent: ctx.ua.raw.slice(0, 200) },
          });
        } else if (ctx.ua.declaresAutomation) {
          results.push({
            detector: "self-identified",
            summary: "User-Agent contains a crawler-like word but publishes no contact address",
            direction: "bot",
            certainty: "strong",
            botClass: "declared-bot",
            metadata: { userAgent: ctx.ua.raw.slice(0, 200) },
          });
        } else {
          // A contact and nothing else. Applications put their own homepage or support
          // address in a User-Agent, and the people behind those are people, so this
          // is the weakest thing this detector emits rather than the strongest.
          results.push({
            detector: "self-identified",
            summary: "User-Agent carries a URL or address but does not describe itself as automated",
            direction: "bot",
            certainty: "weak",
            weight: 0.15,
            metadata: { userAgent: ctx.ua.raw.slice(0, 200) },
          });
        }
      }

      // A bare product token with no browser preamble: `MyService/1.0`. Not in the
      // database, so we cannot name it, but the *shape* is one browsers never emit —
      // and custom internal clients are exactly what this catches, which is why it
      // stays short of certainty and points you at the allowlist.
      if (results.length === 0 && ctx.ua.shape === "library") {
        results.push({
          detector: "self-identified",
          summary: `User-Agent is a bare client token with no browser preamble: "${ctx.ua.raw.slice(0, 80)}"`,
          direction: "bot",
          certainty: "strong",
          botClass: "http-client",
          metadata: { userAgent: ctx.ua.raw.slice(0, 200), products: ctx.ua.products.map((product) => product.name).slice(0, 6) },
        });
      }

      // A completely absent User-Agent. Common in scripts, and also produced by some
      // stripped-down proxies and privacy tooling — which is exactly why it is only
      // suggestive. It is a genuinely weak signal that earns its place by combining.
      if (results.length === 0 && ctx.ua.shape === "empty" && absenceIsMeaningful(ctx)) {
        results.push({
          detector: "self-identified",
          summary: "Request sent no User-Agent header",
          direction: "bot",
          certainty: "moderate",
          botClass: "http-client",
          metadata: { userAgent: null },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}

function classFor(category: BotCategory): BotClass {
  switch (category) {
    case "library":
      return "http-client";
    case "headless":
      return "automation";
    case "security":
      return "scanner";
    case "seo":
      return "scraper";
    case "embedded":
      // Honest answer: an embedded webview says nothing about whether a person is
      // driving it. Naming it "automation" would be asserting something we do not know.
      return "unknown";
    default:
      return "declared-bot";
  }
}
