import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";

// `@osqd/jql` is bundled rather than depended on, so the package keeps its zero runtime
// dependencies — and its own sourcemaps come with it. esbuild follows the
// `sourceMappingURL` in each file it bundles, so every map that bundles the dashboard (the
// main entry and the element, each ESM and CJS) embedded JQL's entire TypeScript
// source: a megabyte across the four, uncompressed, which alone took the tarball past the
// 4 MB CI holds it to. This hands esbuild the same map without its `sourcesContent`. The mappings
// stay, so a stack trace through JQL still names the line of its source it came from; only
// the copy of that source is left out, and it lives in JQL's own repository.
const jqlMapsWithoutSources: Plugin = {
  name: "jql-maps-without-sources",
  setup(build) {
    build.onLoad({ filter: /[\\/]@osqd[\\/]jql[\\/]dist[\\/][^\\/]+\.c?js$/ }, async (args) => {
      const code = await readFile(args.path, "utf8");
      const link = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(code);
      if (link === null) return undefined;
      const map = JSON.parse(await readFile(join(dirname(args.path), link[1] as string), "utf8")) as { sourcesContent?: unknown };
      delete map.sourcesContent;
      const inline = Buffer.from(JSON.stringify(map)).toString("base64");
      return { contents: `${code.slice(0, link.index)}//# sourceMappingURL=data:application/json;base64,${inline}\n`, loader: "js" };
    });
  },
};

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
  esbuildPlugins: [jqlMapsWithoutSources],
});
