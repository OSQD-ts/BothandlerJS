import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";
import * as adapters from "../src/adapters/index.js";
import * as client from "../src/client/index.js";
import * as corpus from "../src/corpus/index.js";

/**
 * What each published entry point actually exports.
 *
 * Every module inside this repository imports its neighbours by path — `./corpus/runner.js`,
 * `./client/index.js` — so nothing here ever exercised the paths the documentation tells
 * other people to use. Two names were missing from the public surface for exactly that
 * reason: `runCorpus`, which is the entire point of publishing `bothandlerjs/corpus`, and
 * which no test could have noticed because every internal caller reaches past the entry
 * point to the file.
 *
 * A name in this list is a promise. Removing one is a breaking change, and this is where
 * that gets said out loud rather than discovered by somebody's failing build.
 *
 * This list is the *documented* surface: what the documentation tells somebody to
 * import. {@link SURFACE} below is the rest of it — every name any published entry point
 * exposes at runtime, so that a name appearing or disappearing is something a diff says
 * out loud. The two exist separately because they mean different things: a name here is
 * a promise, a name there is merely reachable, and 76 of the root module's exports were
 * the second without anybody having decided they should be.
 */
const PROMISED: Record<string, { module: Record<string, unknown>; names: readonly string[] }> = {
  "bothandlerjs": {
    module: root as never,
    names: [
      "BotHandler", "createFacts", "resolveConfig", "validateRules", "ConfigError",
      "combineEvidence", "noisyOr", "sortEvidence", "weightOf", "CERTAINTY_WEIGHT", "VERDICTS", "BOT_CLASSES",
      "defaultDetectors", "BOT_SIGNATURES", "renderTrapLink", "renderTrapField", "trapRobotsEntries",
      "DEFAULT_TRAP_PATHS", "TRAP_FIELD_SOURCE", "trapDetector", "probeSignatureDetector",
      "PRESETS", "monitorOnly", "protectContent", "protectData", "protectAuth", "protectApi",
      "allowCrawlers", "declineAiTraining", "indexersOnly", "underAttack",
      "defineHandler", "generateRobotsTxt", "robotsFromRules", "agentFor",
      "ChallengeService", "parseAcceptLanguage", "pickTranslation",
      "MemoryStore", "RedisStore",
      "consoleNotifier", "webhookNotifier", "slackNotifier",
      "Metrics", "toPrometheus", "TrafficAudit", "DEFAULT_CHECKS",
      "startDashboard", "createDashboardHandler", "renderDashboardPage",
      "ActorRegistry", "ActorState",
      "startCrawlerRangeRefresh", "refreshCrawlerRanges", "PUBLISHED_CRAWLER_RANGES",
      "ManualClock", "systemClock", "IpRangeSet", "parseIp", "parseCidr", "cidrContains", "normalizeIp",
      "parseUserAgent", "parseCookies", "TtlLru", "Emitter",
      // The optional correlation sources and the detectors that arrive with them. Each is
      // documented in `docs/detection/correlation.md` and named in the detector tables, so
      // each is a promise in exactly the sense this list means.
      "MarkerProbe", "SiteProfile",
      "identityDriftDetector", "markerIntegrityDetector", "markerFanoutDetector", "markerPersistenceDetector",
      "challengeReactionDetector", "challengeIntegrityDetector",
      "distributedWalkDetector", "pathNoveltyDetector", "missBaselineDetector", "pathCampaignDetector",
      // Reads the raw request target, which nothing else can see once it is normalised.
      "targetIntegrityDetector",
    ],
  },
  "bothandlerjs/adapters": {
    module: adapters as never,
    names: ["botHandler", "fastifyBotHandler", "koaBotHandler", "withBotHandler", "createFetchAdapter"],
  },
  "bothandlerjs/client": {
    module: client as never,
    names: ["renderClientScript", "clientScriptSource", "parseClientSignals"],
  },
  "bothandlerjs/corpus": {
    module: corpus as never,
    // `runCorpus` is the one this file was written for.
    names: ["runCorpus", "CORPUS", "HUMAN_CASES", "BENIGN_BOT_CASES", "ADVERSARIAL_CASES", "INFRASTRUCTURE_CASES"],
  },
};

describe("the published entry points", () => {
  for (const [entry, { module, names }] of Object.entries(PROMISED)) {
    it(`${entry} exports everything the documentation tells people to import`, () => {
      const missing = names.filter((name) => !(name in module));
      expect(missing, `missing from ${entry}`).toEqual([]);
    });
  }

  it("exposes runCorpus as a function, not merely as a name", async () => {
    expect(typeof corpus.runCorpus).toBe("function");
  });
});

/**
 * And the whole of it, name by name.
 *
 * {@link PROMISED} is the half of the surface the documentation points at. This is the
 * other half plus that one: every runtime export of every published entry point, listed
 * so that adding or removing any of them is a line in a diff rather than something
 * nobody notices until a build somewhere else stops working.
 *
 * The asymmetry is deliberate and worth stating. Everything in `PROMISED` is a promise
 * — removing one is a breaking change. Everything here is merely *reachable*, and the
 * list exists so the decision to publish a name is made on purpose. Several of these
 * are exported because an internal neighbour needed them and the barrel re-exports the
 * module wholesale; that is a reason to have noticed, not a reason to keep them
 * forever. When a name leaves, this test is the conversation about it.
 *
 * Types are absent by construction: they are erased before this runs, so what a
 * `Record<string, unknown>` can see is exactly the runtime surface.
 */
const SURFACE: Record<string, { module: Record<string, unknown>; names: readonly string[] }> = {
  "bothandlerjs": {
    module: root as never,
    names: [
      "ACTION_NAMES", "ActorRegistry", "ActorState", "BENIGN_CATEGORIES", "BOT_CLASSES", "BOT_SIGNATURES",
      "BotHandler", "CAPABILITY_WEIGHTS", "CERTAINTY_WEIGHT", "CREDENTIAL_HEADERS", "ChallengeService",
      "ConfigError", "DEFAULT_CHECKS", "DEFAULT_DIFFICULTY", "DEFAULT_INTERACTION_SETTINGS",
      "DEFAULT_TRAP_PATHS", "DURATION_BUCKETS_MS", "Emitter", "IpRangeSet", "MAX_DIFFICULTY",
      "MAX_USER_AGENT_LENGTH", "ManualClock", "MarkerProbe", "MemoryStore", "Metrics",
      "MultiPatternMatcher", "NotificationHub", "PRESETS", "PUBLISHED_CRAWLER_RANGES", "Policy",
      "RedisStore", "SCORE_BUCKETS", "SPECIAL_USE_RANGES", "SiteProfile", "TERMINAL_ACTIONS",
      "TRAP_FIELD_SOURCE", "TrafficAudit", "TtlLru", "VERDICTS", "absenceIsMeaningful",
      "acceptSignatureDetector", "agentFor", "allowCrawlers", "analyseMovement",
      "blendedIdentityDetector", "browsingCoherenceDetector", "cachingResolver", "cadenceDetector",
      "challengeIntegrityDetector", "challengeReactionDetector", "cidrContains", "claimsBrowser",
      "clampDifficulty", "clearanceDetector", "clientHintsDetector", "clientSignalsDetector",
      "combineEvidence", "compileMatch", "compileSignatures", "consoleNotifier", "countLeadingZeroBits",
      "crawlBreadthDetector", "crawlerVerificationDetector", "createDashboardHandler", "createFacts",
      "declineAiTraining", "defaultDetectors", "defineHandler", "distributedWalkDetector", "evidence",
      "executeAction", "fetchAddressList", "fetchCrawlerRanges", "fetchMetadataDetector", "formatIp",
      "forwardConfirmedReverseDns", "generateRobotsTxt", "headerIntegrityDetector", "headerOrderDetector",
      "headerOrderFingerprint", "idEnumerationDetector", "identityDriftDetector",
      "identityRotationDetector", "independentStrongSignals", "indexSignatures", "indexersOnly",
      "ipIntelligenceDetector", "isSpecialUse", "issueToken", "markerFanoutDetector",
      "markerIntegrityDetector", "markerPersistenceDetector", "missBaselineDetector", "monitorOnly",
      "networkKey", "newChallenge", "newClearance", "nodeDnsResolver", "noisyOr", "normalizeIp",
      "notifyJsNotifier", "parameterSweepDetector", "parseAcceptLanguage", "parseCidr", "parseCookies",
      "parseInteractionReport", "parseIp", "parseUserAgent", "pathCampaignDetector",
      "pathNoveltyDetector", "pickTranslation", "probeShapeFor", "probeSignatureDetector",
      "probeVolumeDetector", "protectApi", "protectAuth", "protectContent", "protectData",
      "rateAnomalyDetector", "redactEvent", "refreshCrawlerRanges", "renderChallengePage",
      "renderDashboardPage", "renderTrapField", "renderTrapLink", "resolveClientIp", "resolveConfig",
      "robotsFromRules", "scoreCapabilities", "scoreMovement", "selfIdentifiedDetector",
      "sendsModernHeaders", "serializeCookie", "sessionIntegrityDetector", "slackNotifier",
      "solveProofOfWork", "sortEvidence", "startCrawlerRangeRefresh", "startDashboard", "systemClock",
      "targetIntegrityDetector", "tlsFingerprintDetector", "toPrometheus", "transportCoherenceDetector", "trapDetector",
      "trapRobotsEntries", "uaCoherenceDetector", "underAttack", "validateRules", "verdictHeaders",
      "verifyInteraction", "verifyProofOfWork", "verifyToken", "webhookNotifier", "weightOf",
    ],
  },
  "bothandlerjs/adapters": {
    module: adapters as never,
    names: [
      "botHandler", "createFetchAdapter", "fastifyBotHandler", "koaBotHandler", "withBotHandler",
    ],
  },
  "bothandlerjs/client": {
    module: client as never,
    names: [
      "clientScriptSource", "parseClientSignals", "renderClientScript",
    ],
  },
  "bothandlerjs/corpus": {
    module: corpus as never,
    names: [
      "ADVERSARIAL_CASES", "ADVERTISING_EMAIL_CASES", "AI_CRAWLER_CASES", "AUDIENCE_STAKES",
      "BENIGN_BOT_CASES", "BINGBOT_IP", "BINGBOT_PTR", "CDN_GATEWAY_CASES", "CORPUS",
      "CORPUS_CRAWLER_RANGES", "DENYING_ACTIONS", "EXTENDED_LIBRARY_CASES", "GOOGLEBOT_IP",
      "GOOGLEBOT_PTR", "HUMAN_APP_CASES", "HUMAN_BROWSER_CASES", "HUMAN_CASES", "INFRASTRUCTURE_CASES",
      "IN_RANGE", "OUT_OF_RANGE", "PROFILES", "PROFILE_NAMES", "REGIONAL_CRAWLER_CASES",
      "REPUTATION_CASES", "TOOLING_CASES", "UNWANTED_BOT_CASES", "VERTICAL_CRAWLER_CASES",
      "assertCorpusIntegrity", "bot", "browser", "casesByAudience", "casesByTag", "categories", "crawler",
      "human", "humanPaced", "plain", "repeat", "runCorpus", "userAgentOf",
    ],
  },
};

describe("the whole published surface", () => {
  for (const [entry, { module, names }] of Object.entries(SURFACE)) {
    it(`${entry} exports these ${names.length} names and no others`, () => {
      const actual = Object.keys(module).sort();
      const listed = [...names].sort();
      expect(actual.filter((name) => !names.includes(name)), `newly exported from ${entry}, and not yet listed`).toEqual([]);
      expect(listed.filter((name) => !(name in module)), `gone from ${entry} — a breaking change if anybody imported it`).toEqual([]);
    });
  }

  it("promises nothing it does not also publish", () => {
    for (const [entry, { names }] of Object.entries(PROMISED)) {
      const surface = SURFACE[entry]?.names ?? [];
      expect(names.filter((name) => !surface.includes(name)), entry).toEqual([]);
    }
  });
});
