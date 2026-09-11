import { defineConfig } from "tsup";

// Five entries, five import paths. `adapters` and `client` are split out of the main
// bundle on purpose: an edge deployment that imports only the Fetch adapter should
// not drag in `node:dns`, and a page that ships the browser signal script should not
// drag in the server engine. `cli` is separate so that requiring the library never
// pulls in `node:readline` and the argument parser.
//
// `corpus` is three hundred kilobytes of traffic fixtures and the harness that runs
// them. It is shipped because the whole point of the corpus is to be pointed at
// *your* configuration rather than at ours — but it is its own entry so that
// importing the library never loads a single case of it.
//
// Every entry gets a sourcemap here, and the CLI's are then left out of the published
// package by a negated pattern in `files`. They were the two largest files in it — each
// entry bundles its own copy of the library, and every map embeds the full TypeScript
// source — and they help nobody using the library: they map the terminal tool's own
// stack traces. Dropping them took the tarball from 4.01 MB, just over the 4 MB budget CI
// holds it to, to 3.02 MB. The library's maps stay, because those are the ones that turn
// a stack trace in somebody's application into a line of `src/`. They are still built,
// so working on the CLI in this repository has them.
export default defineConfig({
  entry: ["src/index.ts", "src/adapters/index.ts", "src/client/index.ts", "src/element/index.ts", "src/corpus/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  target: "es2022",
  splitting: false,
  clean: true,
});
