import { defineConfig } from "vitest/config";

// Node environment, no jsdom. Every detector takes its request as a plain
// `RequestFacts` object and its clock/DNS/store through injected dependencies, so
// tests construct the exact request and environment a case needs — including
// impossible ones — rather than inheriting a simulated browser.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The browser suite has its own config and its own command; it needs a Chromium
    // binary, so it must not fail `npm test` on a checkout that has not installed one.
    exclude: ["tests/browser/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Three exclusions, one reason each.
      //
      // The two `page.ts` files are markup and CSS shipped as template literals,
      // covered by rules that assert on the text rather than execute it — counting
      // their lines here would measure nothing. `client.generated.ts` is that bundle
      // as a string, produced by the build.
      //
      // `src/dashboard/client/` is the browser half of the dashboard. It runs in
      // Chromium under `npm run test:browser`, not here, and a coverage number
      // collected from a suite that cannot execute most of it would be a number about
      // the suite rather than about the code.
      //
      // The whole directory rather than a list of its DOM-touching files, which is a
      // list that drifts every time one is added. The pure modules inside it — the
      // search, the outcome classification, the rule drafting, the replay formats — do
      // have unit tests in `dashboard-client.test.ts`; they are simply not counted
      // here, because "is this directory covered" has one answer and it is "by the
      // browser suite".
      exclude: [
        "src/dashboard/page.ts",
        "src/challenge/page.ts",
        "src/dashboard/client.generated.ts",
        "src/dashboard/client/**",
        // `src/element/` is the same case as the client directory above and excluded for
        // the same reason rather than a new one: it is the embeddable dashboard, it needs
        // a document and a custom-element registry to do anything at all, and it is
        // exercised by the browser suite. Counting it here would report a number about
        // which runner was used rather than about the code — and the alternative, moving
        // the thresholds down until it fits, is the thing the note below rules out.
        //
        // And the same second half applies, which for a while it did not. `element/config.ts`
        // is the pure half — which screens a config leaves standing, what a status code
        // means, where a `src` points — and it is unit-tested in `element.test.ts` like the
        // client's pure modules are. Excluding a directory says where its coverage is
        // measured; it does not say the logic inside goes untested, and reading it that way
        // is how two bugs in the section resolution came to be found in a browser instead.
        "src/element/**",
        // The corpus is data and a harness for it. `corpus.test.ts` runs every case
        // through every preset; counting the fixture files as covered lines would say
        // nothing about anything.
        "src/corpus/**",
      ],
      reporter: ["text-summary", "html"],
      // A ratchet set just under where the suite stands, so a change that tests less
      // than the code it replaces has to say so out loud. Raise these when the number
      // rises; lowering one to make a build pass is the failure, not the fix.
      thresholds: {
        statements: 88,
        branches: 80,
        functions: 85,
        lines: 90,
      },
    },
  },
});
