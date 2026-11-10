/** Small scheduling helpers shared by the tracker's parts. */

/** One pending timer per key; setting a key again restarts its timer. */
export class KeyedTimers<K> {
  private timers = new Map<K, number>();

  set(key: K, delay: number, fn: () => void): void {
    this.clear(key);
    this.timers.set(
      key,
      window.setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, delay)
    );
  }

  has(key: K): boolean {
    return this.timers.has(key);
  }

  clear(key: K): void {
    const t = this.timers.get(key);
    if (t === undefined) return;
    window.clearTimeout(t);
    this.timers.delete(key);
  }

  clearAll(): void {
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
  }
}

/** Runs async work per key strictly in order, so reads and writes of one file never interleave. */
export class KeyedQueue<K> {
  private tails = new Map<K, Promise<void>>();

  constructor(private onError: (e: unknown) => void) {}

  run(key: K, fn: () => Promise<void> | void): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn).catch(this.onError);
    this.tails.set(key, next);
    void next.then(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}
