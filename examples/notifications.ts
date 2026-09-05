/**
 * Wiring alerts up without turning a scrape into an outage of your own paging system.
 *
 * The two settings that matter are `dedupeWindowMs` and `maxPerWindow`. A single
 * scraper produces thousands of identical events a minute, and the first thing an
 * unbounded notifier breaks is the channel you were relying on to tell you about it.
 */
import { BotHandler, consoleNotifier, slackNotifier, webhookNotifier } from "../src/index.js";

export const detector = new BotHandler({
  preset: "protect-content",

  notifications: {
    sinks: [
      consoleNotifier({ format: process.env["NODE_ENV"] === "production" ? "json" : "pretty" }),

      ...(process.env["SLACK_WEBHOOK_URL"] ? [slackNotifier({ url: process.env["SLACK_WEBHOOK_URL"] })] : []),

      ...(process.env["ALERT_WEBHOOK_URL"]
        ? [
            webhookNotifier({
              url: process.env["ALERT_WEBHOOK_URL"],
              // Sign it. An unsigned endpoint accepting bot alerts is an endpoint
              // anyone on the internet can fill with fabricated ones.
              secret: process.env["ALERT_WEBHOOK_SECRET"] ?? "",
              retries: 2,
            }),
          ]
        : []),
    ],

    filter: {
      // `detection` is every non-boring assessment and is far too chatty for a
      // channel a person reads. `action` is "we actually did something", which is
      // the thing worth waking up for.
      types: ["action", "downgrade", "error"],
      minScore: 70,
    },

    // Third-party sinks get a masked address by default. The network is enough to
    // spot a pattern; the exact address belongs in your own logs, not in Slack.
    redaction: { maskIp: true },

    dedupeWindowMs: 60_000,
    maxPerWindow: 100,
  },

  // `downgrade` events are the ones to actually watch. Each is a rule that asked to
  // block and was refused for lack of proof — either your rules are too aggressive,
  // or you are seeing traffic worth writing a sharper detector for.
  onWarning: (message) => console.warn("[bothandler]", message),
});

detector.on("decision", ({ decision }) => {
  if (decision.downgradedFrom) {
    console.warn(`[bothandler] rule "${decision.rule}" wanted ${decision.downgradedFrom}: ${decision.downgradeReason}`);
  }
});
