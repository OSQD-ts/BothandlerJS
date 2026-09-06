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
