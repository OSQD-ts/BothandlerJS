import { describe, expect, it } from "vitest";
import { BotHandler } from "../src/index.js";
import { failingResolver, makeFacts } from "./helpers.js";

describe("actions that must not cost the visitor", () => {
  const facts = () => makeFacts({ headers: { "user-agent": "curl/8.4.0" }, headerOrder: ["user-agent"] });

  // The one place a third party's code runs on the request path. Everything else here
  // — detectors, stores, sinks — degrades to serving the request when it fails.
  it("contains a custom handler that throws", async () => {
    const warnings: string[] = [];
    const handler = new BotHandler({
      resolver: failingResolver(),
      onWarning: (message) => warnings.push(message),
      rules: [{ id: "boom", match: {}, action: "custom", params: { handler: "boom" } }],
      handlers: [
        {
          id: "boom",
          execute: () => {
            throw new Error("third-party handler bug");
          },
        },
      ],
    });
    const { outcome } = await handler.handle(facts());
    expect(outcome.kind).toBe("continue");
    expect(warnings.join(" ")).toContain("third-party handler bug");
  });

  it("contains a custom handler that rejects", async () => {
    const handler = new BotHandler({
      resolver: failingResolver(),
      rules: [{ id: "boom", match: {}, action: "custom", params: { handler: "boom" } }],
      handlers: [{ id: "boom", execute: () => Promise.reject(new Error("async handler bug")) }],
    });
    expect((await handler.handle(facts())).outcome.kind).toBe("continue");
  });

  // Headers configured on a rule were accepted and silently dropped for `allow`
  // alone, which is the "configured but inert" failure the config layer refuses to
  // allow anywhere else.
  it("applies a rule's headers on allow, as it does on tag", async () => {
    for (const action of ["allow", "tag"] as const) {
      const handler = new BotHandler({
        resolver: failingResolver(),
        rules: [{ id: action, match: {}, action, params: { headers: { "x-served-by": action } } }],
      });
      const { outcome } = await handler.handle(facts());
      expect(outcome.kind === "continue" ? outcome.responseHeaders : undefined, action).toEqual({ "x-served-by": action });
    }
  });
});
