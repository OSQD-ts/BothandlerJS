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
export default defineConfig({
  entry: ["src/index.ts", "src/adapters/index.ts", "src/client/index.ts", "src/corpus/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  target: "es2022",
  splitting: false,
  clean: true,
});
