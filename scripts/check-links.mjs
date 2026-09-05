#!/usr/bin/env node
// Every internal link in the documentation, checked.
//
// The README used to be one file, where a wrong anchor was visible the moment you
// scrolled. Split across `docs/`, a link can point at a heading that moved, or a file
// that was renamed, and read perfectly right in the diff. This is cheap enough to run
// on every push, so nothing has to be remembered.
//
// Only local links are followed. Checking that the internet still hosts what it
// hosted yesterday is a different job, and one that fails builds for reasons that
// have nothing to do with the change under test.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every markdown file in the repository, found rather than listed.
 *
 * It used to be a hand-written list, which has the failure mode you would expect: a
 * page added to `docs/` was not checked, and a page *renamed* was reported as "listed
 * for checking but does not exist" — a true statement about the list rather than about
 * the documentation. Walking the tree means a new page is covered the moment it is
 * written, which is the only way this stays true of a directory that has thirty of them.
 */
const IGNORED = new Set(["node_modules", "dist", "coverage", ".git"]);

function markdownUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (IGNORED.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...markdownUnder(path));
    else if (entry.endsWith(".md")) found.push(relative(root, path));
  }
  return found;
}

const FILES = markdownUnder(root).sort();

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
/** Fenced code blocks contain links that are examples, not references. */
const FENCE = /^\s*```/;

/** GitHub's heading-to-anchor rule, near enough: lowercase, drop punctuation, spaces to hyphens. */
function anchorsOf(text) {
  const found = new Set();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || !line.startsWith("#")) continue;
    const title = line.replace(/^#+\s*/, "").trim().toLowerCase();
    found.add(
      title
        .replace(/`/g, "")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-"),
    );
  }
  return found;
}

function linksOf(text) {
  const found = [];
  let fenced = false;
  text.split("\n").forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return;
    for (const [, label, target] of line.matchAll(LINK)) found.push({ label, target, line: index + 1 });
  });
  return found;
}

const cache = new Map();
function anchorsFor(path) {
  if (!cache.has(path)) cache.set(path, anchorsOf(readFileSync(path, "utf8")));
  return cache.get(path);
}

const problems = [];
let checked = 0;

for (const file of FILES) {
  const path = join(root, file);
  if (!existsSync(path)) {
    problems.push(`${file}: listed for checking but does not exist`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  for (const { label, target, line } of linksOf(text)) {
    if (/^(https?:|mailto:|#!)/.test(target)) continue;
    checked++;
    const [filePart, anchor] = target.split("#");
    const destination = filePart === "" ? path : resolve(dirname(path), filePart);

    if (!existsSync(destination)) {
      problems.push(`${file}:${line}: no such file — [${label}](${target})`);
      continue;
    }
    if (anchor === undefined || anchor === "") continue;
    if (!destination.endsWith(".md")) continue;
    if (!anchorsFor(destination).has(anchor)) {
      problems.push(`${file}:${line}: no heading "${anchor}" in ${relative(root, destination)} — [${label}](${target})`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} broken link(s) of ${checked} checked.`);
  process.exit(1);
}

console.log(`${checked} internal links across ${FILES.length} markdown files, all resolving.`);
