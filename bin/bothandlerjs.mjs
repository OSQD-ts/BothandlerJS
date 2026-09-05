#!/usr/bin/env node
// Thin launcher. Everything lives in the build so the CLI and the library share one
// implementation — a CLI that reimplements the engine is a CLI that drifts from it.
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
