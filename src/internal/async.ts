/**
 * Runs `work` and resolves to `fallback` if it takes longer than `ms`.
 *
 * Detection runs inline on the request path, so an unbounded await is an
 * availability bug: a slow reverse-DNS lookup or a stalled Redis round-trip would
 * hold the response open. Every I/O-bound detector is wrapped in this, and a
 * timeout degrades that one detector rather than the request.
 *
 * The underlying promise is not cancelled (JS has no such mechanism) but its result
 * is discarded and its rejection swallowed, so a late failure cannot surface as an
 * unhandled rejection.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work;
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    // `unref` where available: a pending detection timer must never be the thing
    // keeping a CLI or a serverless invocation alive.
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** `Promise.allSettled` semantics without allocating a settled-result wrapper per item. */
export async function settleAll(work: Iterable<Promise<void>>): Promise<void> {
  await Promise.all([...work].map((promise) => promise.catch(() => undefined)));
}

export function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}
