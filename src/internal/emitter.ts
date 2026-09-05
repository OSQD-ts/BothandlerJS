/**
 * Minimal typed event emitter.
 *
 * Not `node:events`: listeners here are isolated so that one badly-written
 * subscriber cannot take down request handling. A throwing listener is reported to
 * `onError` and the remaining listeners still run — the same isolation guarantee the
 * detector pipeline gives.
 */
export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  constructor(private readonly onError: (error: unknown, event: string) => void = () => {}) {}

  on<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set.delete(listener as Listener<never>);
    };
  }

  off<K extends keyof Events & string>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events & string>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of set) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (error) {
        this.onError(error, event);
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
