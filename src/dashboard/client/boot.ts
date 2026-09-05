import type { Boot } from "./types.js";

/**
 * What the server told the page about itself.
 *
 * Stamped into the one nonced `<script>` as a JSON string and parsed here, rather than
 * fetched: the title, the mount path and — the part that matters — which sections and
 * controls this listener has. A page that had to ask for those would spend its first
 * frame drawing tabs it is about to remove.
 */
const raw = (globalThis as unknown as { __BOOTSTRAP__?: Boot }).__BOOTSTRAP__;

export const BOOT: Boot = raw ?? {
  base: "",
  title: "bothandlerjs",
  allowReset: false,
  allowEdit: false,
  allowGuardEdit: false,
  allowActing: false,
  peers: [],
  sections: { feed: true, evidence: true, actors: true, registry: true, tester: true, statistics: true, audit: true, notices: true, changes: true, policy: true, guard: true, robots: true, ranges: true },
  links: [],
};

/** Every request the page makes is relative to the mount path. */
export const API = BOOT.base;

export const SECTIONS = BOOT.sections;
