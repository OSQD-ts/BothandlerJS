#!/usr/bin/env node
// The next version, derived from the commits since the last release.
//
//   node scripts/next-version.mjs            → prints the version, or nothing
//   node scripts/next-version.mjs --explain  → prints the reasoning to stderr as well
//
// ## Why derive it rather than declare it
//
// A version bumped by hand is a number somebody chose while thinking about something
// else. It drifts: a release goes out as a patch because that is what the last one was,
// and the breaking change inside it is discovered by whoever upgrades. The commits
// already say what happened — this repository has written `feat:`, `fix:` and `docs:`
// since its first commit — so the version is a fact to be read rather than a decision to
// be remembered.
//
// ## The rules, in full
//
//   feat:                  → minor
//   fix: / perf:           → patch
//   anything with a `!`    → major, or minor while the major is 0
//   BREAKING CHANGE: body  → the same
//   docs/ci/test/chore/…   → nothing at all
//
// The last line is the one that matters most: a push that only touches documentation
// publishes nothing. Without it, "every push to main deploys" means a registry full of
// versions whose only difference is a typo fix in a comment.
//
// While the major version is 0 a breaking change bumps the minor, which is what SemVer
// says 0.x is for: anything may change, and the way to say "this is now stable" is to
// release 1.0.0 deliberately rather than to have a stray `!` do it for you.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const explain = process.argv.includes("--explain");
const say = (message) => {
  if (explain) process.stderr.write(`${message}\n`);
};

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * The commit the last release was cut at.
 *
 * The tag rather than the version in package.json, because the tag is what the previous
 * run of this actually published; package.json can be edited by anyone at any time and
 * says nothing about what reached the registry.
 */
function lastReleaseTag() {
  const tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean);
  return tags[0];
}

/** `type(scope)!: subject` → the parts that decide a version. */
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s/;

/**
 * What one commit does to the version. Exported, and tested in
 * `tests/next-version.test.ts`, because this is the function that decides what the
 * world gets: a rule that quietly reads `feat` as a patch would publish a feature
 * release as a bug fix, and nothing downstream would notice until somebody pinned a
 * caret range and did not get it.
 */
export function classify(message) {
  const [header, ...rest] = message.split("\n");
  const match = HEADER.exec(header ?? "");
  const body = rest.join("\n");
  // The footer form is the one the specification actually requires tooling to honour,
  // and it is the one people reach for when the `!` would not fit in the subject line.
  if (/^BREAKING[ -]CHANGE:/m.test(body)) return "major";
  if (match === null) return "none";
  if (match.groups.breaking === "!") return "major";
  if (match.groups.type === "feat") return "minor";
  if (match.groups.type === "fix" || match.groups.type === "perf") return "patch";
  return "none";
}

export const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

function main() {
  const since = lastReleaseTag();
  const range = since === undefined ? "HEAD" : `${since}..HEAD`;
  say(since === undefined ? "no v* tag yet — reading every commit" : `commits since ${since}`);

  // \x00 between commits, because a commit body may contain anything a person can type,
  // newlines and dashes included. Splitting on a text marker is how a release script
  // reads half a commit and decides it was a chore.
  const raw = git("log", range, "--format=%B%x00");
  const commits = raw.split("\0").map((c) => c.trim()).filter(Boolean);

  let bump = "none";
  for (const commit of commits) {
    const kind = classify(commit);
    if (RANK[kind] > RANK[bump]) bump = kind;
    say(`  ${kind.padEnd(5)}  ${commit.split("\n")[0].slice(0, 72)}`);
  }

  if (bump === "none") {
    say(commits.length === 0 ? "nothing new since the last release" : "nothing here changes what the library does");
    return undefined;
  }

  const current = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const next = bumpVersion(current, bump);
  say(`${current} → ${next}  (${bump})`);
  return next;
}

/**
 * Applies a bump to a version.
 *
 * While the major is 0 a breaking change lands on the minor, which is what SemVer says
 * 0.x is for. Reaching 1.0.0 should be somebody deciding the API is stable, not a stray
 * `!` in a commit subject doing it on their behalf.
 */
export function bumpVersion(current, bump) {
  const [major, minor, patch] = current.split("-")[0].split(".").map(Number);
  const effective = bump === "major" && major === 0 ? "minor" : bump;
  if (effective === "major") return `${major + 1}.0.0`;
  if (effective === "minor") return `${major}.${minor + 1}.0`;
  if (effective === "patch") return `${major}.${minor}.${patch + 1}`;
  return current;
}

/** Run only when invoked, so a test can import the rules without shelling out to git. */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const next = main();
  if (next !== undefined) process.stdout.write(`${next}\n`);
}
