import { describe, expect, it } from "vitest";
import { createLockSet, createViewSync, type SyncActivity } from "../web/src/sync";

// The page's copy of the application: writes one at a time, an older answer never replacing a newer
// one, reads that wait for writes, and the per-proposal lock that Confirm all shares with Confirm.

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets every promise callback that is ready run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness() {
  const shown: string[] = [];
  const errors: unknown[] = [];
  const activity: SyncActivity[] = [];
  const reads: Array<Deferred<string>> = [];
  const sync = createViewSync<string>({
    load: () => {
      const read = deferred<string>();
      reads.push(read);
      return read.promise;
    },
    onView: (view) => shown.push(view),
    onLoadError: (error) => errors.push(error),
    onActivity: (next) => activity.push(next),
  });
  sync.attach();
  return { sync, shown, errors, activity, reads };
}

describe("createViewSync writes", () => {
  it("runs writes one at a time, in the order they were made, and shows each answer in that order", async () => {
    const { sync, shown } = harness();
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];
    const a = sync.write(() => {
      started.push("a");
      return first.promise;
    });
    const b = sync.write(() => {
      started.push("b");
      return second.promise;
    });
    await settle();
    // The second write has not been sent: its answer cannot overtake the first.
    expect(started).toEqual(["a"]);
    expect(sync.activity().writes).toBe(2);
    first.resolve("after-a");
    await a;
    await settle();
    expect(started).toEqual(["a", "b"]);
    second.resolve("after-b");
    await b;
    expect(shown).toEqual(["after-a", "after-b"]);
    expect(sync.activity().writes).toBe(0);
  });

  it("rejects with the write's error, shows nothing for it and still runs the next write", async () => {
    const { sync, shown } = harness();
    const failing = sync.write(() => Promise.reject(new Error("rejected by the server")));
    const next = sync.write(() => Promise.resolve("after-next"));
    await expect(failing).rejects.toThrow("rejected by the server");
    await next;
    expect(shown).toEqual(["after-next"]);
    expect(sync.activity().writes).toBe(0);
  });
});

describe("createViewSync reads", () => {
  it("drops a read that was sent before a write when the write's answer is already shown", async () => {
    const { sync, shown, reads } = harness();
    const read = sync.refresh();
    expect(reads).toHaveLength(1);
    await sync.write(() => Promise.resolve("after-write"));
    reads[0]?.resolve("older-than-the-write");
    await read;
    expect(shown).toEqual(["after-write"]);
  });

  it("shows a newer read even when an older one answers after it", async () => {
    const { sync, shown, reads } = harness();
    const first = sync.refresh();
    const second = sync.refresh();
    reads[1]?.resolve("newer");
    await second;
    reads[0]?.resolve("older");
    await first;
    expect(shown).toEqual(["newer"]);
  });

  it("shows reads that answer in order", async () => {
    const { sync, shown, reads } = harness();
    const first = sync.refresh();
    const second = sync.refresh();
    reads[0]?.resolve("one");
    reads[1]?.resolve("two");
    await Promise.all([first, second]);
    expect(shown).toEqual(["one", "two"]);
  });

  it("holds a read back while writes are outstanding, then sends one read for all the requests made meanwhile", async () => {
    const { sync, shown, reads, activity } = harness();
    const pending = deferred<string>();
    const write = sync.write(() => pending.promise);
    const first = sync.refresh();
    const second = sync.refresh();
    await settle();
    expect(reads).toHaveLength(0);
    expect(sync.activity()).toEqual({ writes: 1, refreshing: true });
    pending.resolve("after-write");
    await write;
    await settle();
    expect(reads).toHaveLength(1);
    // Never idle in between: the form stays blocked until the reload lands.
    expect(sync.activity().refreshing).toBe(true);
    reads[0]?.resolve("after-reload");
    await Promise.all([first, second]);
    expect(shown).toEqual(["after-write", "after-reload"]);
    expect(sync.activity()).toEqual({ writes: 0, refreshing: false });
    // From the first write to the end of the reload the sync never reported idle.
    expect(activity.slice(1, -1).some((entry) => entry.writes === 0 && !entry.refreshing)).toBe(false);
  });

  it("reports a failed read only while nothing newer is shown", async () => {
    const { sync, shown, errors, reads } = harness();
    const stale = sync.refresh();
    await sync.write(() => Promise.resolve("after-write"));
    reads[0]?.reject(new Error("late failure"));
    await stale;
    expect(errors).toEqual([]);

    const alone = sync.refresh();
    reads[1]?.reject(new Error("unreachable"));
    await alone;
    expect(errors).toHaveLength(1);
    expect(shown).toEqual(["after-write"]);
  });
});

describe("createViewSync activity and ownership", () => {
  it("reports changes in the number of writes and in whether a read is outstanding", async () => {
    const { sync, reads, activity } = harness();
    const done = sync.refresh();
    await sync.write(() => Promise.resolve("x"));
    reads[0]?.resolve("y");
    await done;
    expect(activity[0]).toEqual({ writes: 0, refreshing: false });
    expect(activity).toContainEqual({ writes: 0, refreshing: true });
    expect(activity).toContainEqual({ writes: 1, refreshing: true });
    expect(activity[activity.length - 1]).toEqual({ writes: 0, refreshing: false });
  });

  it("delivers nothing after detach, and the current activity again on attach", async () => {
    const { sync, shown, errors, activity, reads } = harness();
    const read = sync.refresh();
    sync.detach();
    reads[0]?.resolve("after-detach");
    await read;
    await sync.write(() => Promise.resolve("write-after-detach"));
    expect(shown).toEqual([]);
    expect(errors).toEqual([]);
    const before = activity.length;
    sync.attach();
    expect(activity).toHaveLength(before + 1);
    expect(activity[activity.length - 1]).toEqual({ writes: 0, refreshing: false });
  });
});

describe("createLockSet", () => {
  it("takes every id or none, and frees them on release", () => {
    const locks = createLockSet();
    expect(locks.acquire(["p1"])).toBe(true);
    expect(locks.has("p1")).toBe(true);
    // A bulk request over p1 and p2 cannot start while p1 is held, and takes nothing.
    expect(locks.acquire(["p1", "p2"])).toBe(false);
    expect(locks.has("p2")).toBe(false);
    locks.release(["p1"]);
    expect(locks.acquire(["p1", "p2"])).toBe(true);
    expect([...locks.snapshot()].sort()).toEqual(["p1", "p2"]);
  });

  it("keeps a single Confirm and Confirm all from overlapping on the same proposal", () => {
    const locks = createLockSet();
    const proposals = ["p1", "p2", "p3"];
    // Confirm all in flight: no single request may start on any of them.
    expect(locks.acquire(proposals)).toBe(true);
    for (const id of proposals) expect(locks.acquire([id])).toBe(false);
    locks.release(proposals);
    // A single Confirm in flight: Confirm all may not start; another proposal's request may.
    expect(locks.acquire(["p2"])).toBe(true);
    expect(locks.acquire(proposals)).toBe(false);
    expect(locks.acquire(["p3"])).toBe(true);
  });

  it("refuses an empty request and returns a snapshot that later changes do not touch", () => {
    const locks = createLockSet();
    expect(locks.acquire([])).toBe(false);
    locks.acquire(["p1"]);
    const snapshot = locks.snapshot();
    locks.release(["p1"]);
    expect(snapshot.has("p1")).toBe(true);
    expect(locks.has("p1")).toBe(false);
  });
});
