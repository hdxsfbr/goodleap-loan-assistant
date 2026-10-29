// Keeps the page's copy of the application in step with the server's. Pure: no DOM, no network.
//
// Two things can go wrong with a copy that several requests update. A response that left the server
// earlier can arrive after a later one and put old data back, and two writes can overlap for the same
// proposal. `createViewSync` answers the first (writes run one at a time; a response is adopted only if
// it was requested after the last one adopted; reads wait for the writes to finish) and `createLockSet`
// the second.

export interface ViewSyncDeps<V> {
  /** Fetches the server's current copy. */
  load(): Promise<V>;
  /** A newer copy than any shown so far. */
  onView(view: V): void;
  /** A read failed and no newer copy has been shown since. */
  onLoadError(error: unknown): void;
  /** The activity changed. */
  onActivity(activity: SyncActivity): void;
}

export interface SyncActivity {
  /** Writes queued or in flight. */
  writes: number;
  /** A read is in flight, or is waiting for the writes to finish. */
  refreshing: boolean;
}

export interface ViewSync<V> {
  /** Reads the server's copy. While writes are outstanding the read waits for them, then runs once. */
  refresh(): Promise<void>;
  /** Runs a write after every earlier write has finished, and shows the copy it returns. Rejects with the write's error. */
  write(work: () => Promise<V>): Promise<V>;
  /** Starts delivering to the deps (the owner is on screen). Idempotent. */
  attach(): void;
  /** Stops delivering: whatever is still in flight is dropped when it lands. */
  detach(): void;
  activity(): SyncActivity;
}

export function createViewSync<V>(deps: ViewSyncDeps<V>): ViewSync<V> {
  let live = false;
  // Requests are numbered when they are sent; a response may be shown only if its number is above the last shown.
  let issued = 0;
  let shown = 0;
  let writes = 0;
  let reads = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let waiting: { promise: Promise<void>; resolve(): void } | null = null;
  let last: SyncActivity = { writes: 0, refreshing: false };

  const activity = (): SyncActivity => ({ writes, refreshing: reads > 0 || waiting !== null });

  const notify = () => {
    const next = activity();
    if (next.writes === last.writes && next.refreshing === last.refreshing) return;
    last = next;
    if (live) deps.onActivity(next);
  };

  const adopt = (stamp: number, view: V) => {
    if (stamp <= shown) return;
    shown = stamp;
    if (live) deps.onView(view);
  };

  const read = async (): Promise<void> => {
    const stamp = ++issued;
    reads += 1;
    notify();
    try {
      adopt(stamp, await deps.load());
    } catch (error) {
      if (stamp > shown && live) deps.onLoadError(error);
    } finally {
      reads -= 1;
      notify();
    }
  };

  const drain = () => {
    if (writes > 0 || waiting === null) return;
    const done = waiting;
    // Start the read before clearing the wait so `refreshing` never reads false in between.
    const running = read();
    waiting = null;
    void running.finally(done.resolve);
  };

  return {
    refresh() {
      if (writes === 0) return read();
      if (waiting === null) {
        let resolve: () => void = () => undefined;
        const promise = new Promise<void>((settle) => {
          resolve = settle;
        });
        waiting = { promise, resolve };
        notify();
      }
      return waiting.promise;
    },

    write(work) {
      writes += 1;
      notify();
      const run = async (): Promise<V> => {
        const stamp = ++issued;
        try {
          const view = await work();
          adopt(stamp, view);
          return view;
        } finally {
          writes -= 1;
          drain();
          notify();
        }
      };
      const result = queue.then(run);
      queue = result.catch(() => undefined);
      return result;
    },

    attach() {
      live = true;
      last = activity();
      deps.onActivity(last);
    },
    detach() {
      live = false;
    },
    activity,
  };
}

/** A set of ids with a request in flight. Taking an id that is held fails, so two requests never overlap on it. */
export interface LockSet {
  /** Takes every id, or none: false when any is already held. */
  acquire(ids: readonly string[]): boolean;
  release(ids: readonly string[]): void;
  has(id: string): boolean;
  /** The ids held now, as a new set. */
  snapshot(): ReadonlySet<string>;
}

export function createLockSet(): LockSet {
  const held = new Set<string>();
  return {
    acquire(ids) {
      if (ids.length === 0 || ids.some((id) => held.has(id))) return false;
      for (const id of ids) held.add(id);
      return true;
    },
    release(ids) {
      for (const id of ids) held.delete(id);
    },
    has: (id) => held.has(id),
    snapshot: () => new Set(held),
  };
}
