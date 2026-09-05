/**
 * Aho–Corasick multi-pattern matcher over lowercase ASCII.
 *
 * The known-bot database holds a few hundred literal signatures, and every request
 * has to be checked against all of them. The naive approach — a loop of
 * `haystack.includes(needle)` or, worse, a list of regexes — is O(patterns × length)
 * per request and scales with the size of the database, which is the thing most
 * likely to grow.
 *
 * This runs in a single pass over the input, O(length + matches), independent of how
 * many patterns are registered. Automata are built once at construction and are
 * immutable afterwards, so they can be shared freely across requests and instances.
 */
/** Shared empty result. Frozen so a caller cannot mutate every future no-match answer. */
const EMPTY: readonly never[] = Object.freeze([]);

export class MultiPatternMatcher<T> {
  /** Transition tables, one Map per node, indexed by character code. */
  private readonly transitions: Map<number, number>[] = [new Map()];
  private readonly fail: number[] = [0];
  /** Payloads that end at each node, plus everything reachable via fail links. */
  private readonly outputs: T[][] = [[]];
  /** Longest pattern registered — lets callers skip inputs that cannot match. */
  readonly maxPatternLength: number = 0;
  readonly patternCount: number;
  /**
   * Flat transition table for the root node over 7-bit ASCII.
   *
   * A scan of text that matches nothing — every request from a real browser — sits at
   * the root for its entire length, so the root's transition lookup happens once per
   * character and dominates everything else. A `Map.get` there costs a hash and a
   * bucket probe; an array index costs neither. 512 bytes, built once.
   *
   * Patterns are overwhelmingly lowercase ASCII. The rare one that is not — a crawler
   * that names itself in Cyrillic or Han — gets a root transition above 127, which the
   * flat table cannot hold; those live in {@link rootWide}, left undefined when there
   * are none so the common case pays one `undefined` check.
   */
  private readonly rootAscii = new Int32Array(128);
  private readonly rootWide: Map<number, number> | undefined;

  constructor(patterns: Iterable<readonly [pattern: string, payload: T]>) {
    let count = 0;
    let maxLength = 0;

    for (const [rawPattern, payload] of patterns) {
      if (rawPattern.length === 0) continue;
      // Lowercased here rather than trusted from the caller. `matchAll` scans an
      // already-lowercased haystack, so a pattern carrying a capital can never match
      // anything — and it fails by matching nothing at all, which looks exactly like a
      // signature that is simply never seen. Normalising once at build time turns that
      // silent dead entry into a working one at no per-request cost.
      const pattern = rawPattern.toLowerCase();
      count++;
      maxLength = Math.max(maxLength, pattern.length);
      let node = 0;
      for (let i = 0; i < pattern.length; i++) {
        const code = pattern.charCodeAt(i);
        let next = this.transitions[node]!.get(code);
        if (next === undefined) {
          next = this.transitions.length;
          this.transitions.push(new Map());
          this.fail.push(0);
          this.outputs.push([]);
          this.transitions[node]!.set(code, next);
        }
        node = next;
      }
      this.outputs[node]!.push(payload);
    }

    this.patternCount = count;
    this.maxPatternLength = maxLength;
    this.buildFailureLinks();

    let wide: Map<number, number> | undefined;
    for (const [code, target] of this.transitions[0]!) {
      if (code < 128) this.rootAscii[code] = target;
      else (wide ??= new Map()).set(code, target);
    }
    this.rootWide = wide;
  }

  /** Root-node transition. Kept separate so the hot loop reads an array, not a Map. */
  private fromRoot(code: number): number {
    if (code < 128) return this.rootAscii[code]!;
    return this.rootWide === undefined ? 0 : (this.rootWide.get(code) ?? 0);
  }

  private buildFailureLinks(): void {
    const queue: number[] = [];
    for (const child of this.transitions[0]!.values()) {
      this.fail[child] = 0;
      queue.push(child);
    }
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head]!;
      // Merging the fail node's outputs in at build time makes `search` a plain
      // walk with no fail-link chasing per character.
      const failOutputs = this.outputs[this.fail[node]!]!;
      if (failOutputs.length > 0) this.outputs[node]!.push(...failOutputs);

      for (const [code, child] of this.transitions[node]!) {
        let candidate = this.fail[node]!;
        while (candidate !== 0 && !this.transitions[candidate]!.has(code)) candidate = this.fail[candidate]!;
        const target = this.transitions[candidate]!.get(code);
        this.fail[child] = target !== undefined && target !== child ? target : 0;
        queue.push(child);
      }
    }
  }

  /**
   * Every distinct payload whose pattern occurs in `haystack`. The input must
   * already be lowercased — casing is normalised by the caller, once, rather than
   * per pattern.
   *
   * The no-match case allocates nothing and returns a shared frozen array. That is
   * the case for every request from a person, so it is the one worth making free.
   */
  matchAll(haystack: string): readonly T[] {
    if (this.patternCount === 0 || haystack.length === 0) return EMPTY;
    let found: Set<T> | undefined;
    let node = 0;
    for (let i = 0; i < haystack.length; i++) {
      const code = haystack.charCodeAt(i);
      if (node === 0) {
        node = this.fromRoot(code);
      } else {
        while (node !== 0 && !this.transitions[node]!.has(code)) node = this.fail[node]!;
        node = node === 0 ? this.fromRoot(code) : (this.transitions[node]!.get(code) ?? 0);
      }
      const output = this.outputs[node]!;
      if (output.length === 0) continue;
      found ??= new Set<T>();
      for (let j = 0; j < output.length; j++) found.add(output[j]!);
    }
    return found === undefined ? EMPTY : [...found];
  }

  /** Cheap existence check that stops at the first hit. */
  matchFirst(haystack: string): T | undefined {
    if (this.patternCount === 0) return undefined;
    let node = 0;
    for (let i = 0; i < haystack.length; i++) {
      const code = haystack.charCodeAt(i);
      if (node === 0) {
        node = this.fromRoot(code);
      } else {
        while (node !== 0 && !this.transitions[node]!.has(code)) node = this.fail[node]!;
        node = node === 0 ? this.fromRoot(code) : (this.transitions[node]!.get(code) ?? 0);
      }
      const output = this.outputs[node]!;
      if (output.length > 0) return output[0];
    }
    return undefined;
  }

  has(haystack: string): boolean {
    return this.matchFirst(haystack) !== undefined;
  }
}
