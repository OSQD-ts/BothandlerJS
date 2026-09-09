import type { Boot } from "./types.js";

/**
 * What the server told the page about itself.
 *
 * Stamped into the one nonced `<script>` as a JSON string and parsed here, rather than
 * fetched: the title, the mount path and — the part that matters — which sections and
 * controls this listener has. A page that had to ask for those would spend its first
 * frame drawing tabs it is about to remove.
 */
const FALLBACK: Boot = {
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

/**
 * Reassignable, and that is the fix for a real bug rather than a style choice.
 *
 * On the served page this module evaluates after the nonced script has stamped the
 * global, so reading it once was right. Embedded, the element sets the global and *then*
 * imports the client — correct, and not something it can actually guarantee, because any
 * other code path that reaches a client module first evaluates this one first.
 *
 * One did. `disconnectedCallback` imports `stream.js` to close the stream, `stream.js`
 * imports this, and a host page that mounts, unmounts and remounts the element before the
 * first bootstrap fetch returns — React 18's development double-mount, exactly — ran that
 * import while the global was still undefined. `base` then froze at `""` for the life of
 * the page, so every request the dashboard made went to the host application's own origin
 * root instead of to `src`: no dashboard, and a stray `/api/stream` arriving at somebody
 * else's router.
 *
 * These are `let` and {@link applyBoot} replaces them, so being evaluated early costs
 * nothing. ES module bindings are live and esbuild keeps them so — importers read the
 * variable, not a copy of it — which is what makes this work without every consumer
 * changing to a getter.
 */
export let BOOT: Boot = (globalThis as unknown as { __BOOTSTRAP__?: Boot }).__BOOTSTRAP__ ?? FALLBACK;

/** Every request the page makes is relative to the mount path. */
export let API = BOOT.base;

export let SECTIONS = BOOT.sections;

/**
 * Points this module at the payload the element fetched.
 *
 * Called before the client is imported. Ordering still matters for *drawing* — the client
 * builds its tab strip from these — but no longer for correctness of the mount path,
 * which is the part that was silently wrong.
 */
export function applyBoot(next: Boot): void {
  BOOT = next;
  API = next.base;
  SECTIONS = next.sections;
}
