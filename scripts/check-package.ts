import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Packs the tarball, installs it somewhere else, and imports every entry point the
 * documentation names — as ESM and as CommonJS.
 *
 * CI already checks that the right files are *in* the package: the `files` allowlist, the
 * absence of junk, the size. None of that checks they can be *loaded*, and the difference
 * has bitten this package before. `bothandlerjs/element` once threw
 * `ReferenceError: HTMLElement is not defined` the moment anything imported it outside a
 * browser — a file present, correctly listed in `exports`, fully type-checked, and unusable.
 * It was found by packing a tarball by hand.
 *
 * Importing from `src` cannot find that class of bug, which is why the entry-point unit
 * test cannot either: it reaches past the published paths to the files behind them. This
 * is the only check that resolves the package the way somebody installing it does.
 */

const SUBPATHS = ["", "/adapters", "/client", "/element", "/corpus", "/cli"] as const;

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const repo = process.cwd();
const name = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { name: string }).name;
const scratch = mkdtempSync(join(tmpdir(), "bothandler-package-"));
let failures = 0;

try {
  process.stdout.write("packing…\n");
  const tarball = run("npm", ["pack", "--silent"], repo).trim().split("\n").pop() as string;

  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  process.stdout.write(`installing ${tarball} into a clean directory…\n`);
  run("npm", ["install", "--no-audit", "--no-fund", "--silent", join(repo, tarball)], scratch);

  for (const subpath of SUBPATHS) {
    const specifier = `${name}${subpath}`;
    // Each in its own process: a module that throws on load must not take the others
    // with it, and CommonJS and ESM resolve through different halves of `exports`.
    for (const [kind, source] of [
      ["import", `import * as m from ${JSON.stringify(specifier)}; if (Object.keys(m).length === 0) { throw new Error("no exports"); } console.log(Object.keys(m).length);`],
      ["require", `const m = require(${JSON.stringify(specifier)}); if (Object.keys(m).length === 0) { throw new Error("no exports"); } console.log(Object.keys(m).length);`],
    ] as const) {
      const file = join(scratch, `probe.${kind === "import" ? "mjs" : "cjs"}`);
      writeFileSync(file, source);
      try {
        const count = run(process.execPath, [file], scratch).trim();
        process.stdout.write(`  ok    ${kind.padEnd(8)} ${specifier.padEnd(32)} ${count} exports\n`);
      } catch (error) {
        failures++;
        const message = error instanceof Error && "stderr" in error ? String((error as { stderr: unknown }).stderr) : String(error);
        process.stdout.write(`  FAIL  ${kind.padEnd(8)} ${specifier.padEnd(32)} ${message.split("\n").filter(Boolean)[0] ?? ""}\n`);
      }
    }
  }

  // The command, run the way somebody who installed the package runs it. `bin` points at
  // `../dist/cli.js`, and every test of the CLI imports `src/cli.ts` instead — so a build
  // that stopped emitting that file would leave the whole suite green and the command
  // broken for everybody.
  try {
    const help = run(process.execPath, [join(scratch, "node_modules", name, "bin", "bothandlerjs.mjs"), "--help"], scratch);
    if (!help.includes("bothandlerjs")) throw new Error("--help printed nothing recognisable");
    process.stdout.write("  ok    bin      bothandlerjs --help              runs\n");
  } catch (error) {
    failures++;
    const message = error instanceof Error && "stderr" in error ? String((error as { stderr: unknown }).stderr) : String(error);
    process.stdout.write(`  FAIL  bin      bothandlerjs --help              ${message.split("\n").filter(Boolean)[0] ?? ""}\n`);
  }

  rmSync(join(repo, tarball), { force: true });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures > 0) {
  process.stdout.write(`\n${failures} entry point(s) could not be loaded from the packed tarball.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\nEvery published entry point loads, as ESM and as CommonJS.\n");
}
