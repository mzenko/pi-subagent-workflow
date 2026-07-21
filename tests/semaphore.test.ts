import { expect, test } from "bun:test";
import { Semaphore } from "../src/runner/semaphore.js";

test("semaphore shares its cap across nested callers", async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let peak = 0;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  const jobs = Array.from({ length: 5 }, async () => {
    const release = await semaphore.acquire();
    try {
      active += 1; peak = Math.max(peak, active);
      await gate;
      active -= 1;
    } finally {
      release();
    }
  });
  await Bun.sleep(5);
  expect(semaphore.running).toBe(2);
  expect(semaphore.pending).toBe(3);
  openGate();
  await Promise.all(jobs);
  expect(peak).toBe(2);
});

test("an aborted queued acquire leaves the queue and later waiters still admit in order", async () => {
  const semaphore = new Semaphore(1);
  const holder = await semaphore.acquire();
  const controller = new AbortController();
  const aborted = semaphore.acquire(controller.signal);
  const admitted: string[] = [];
  const behind = semaphore.acquire().then((release) => { admitted.push("behind"); return release; });
  expect(semaphore.pending).toBe(2);
  controller.abort();
  await expect(aborted).rejects.toThrow("Semaphore acquire aborted");
  expect(semaphore.pending).toBe(1);
  holder();
  const releaseBehind = await behind;
  expect(admitted).toEqual(["behind"]);
  releaseBehind();
  // Slot fully recovered: an immediate acquire succeeds without queueing.
  const last = await semaphore.acquire();
  expect(semaphore.pending).toBe(0);
  last();
});

test("acquire with an already-aborted signal throws without touching the queue", async () => {
  const semaphore = new Semaphore(1);
  const controller = new AbortController();
  controller.abort();
  await expect(semaphore.acquire(controller.signal)).rejects.toThrow("Semaphore acquire aborted");
  expect(semaphore.running).toBe(0);
  expect(semaphore.pending).toBe(0);
});

test("increasing capacity immediately admits queued work", async () => {
  const semaphore = new Semaphore(1);
  const first = await semaphore.acquire();
  const admitted: number[] = [];
  const second = semaphore.acquire().then((release) => { admitted.push(2); return release; });
  const third = semaphore.acquire().then((release) => { admitted.push(3); return release; });
  expect(semaphore.pending).toBe(2);

  semaphore.resize(3);
  const [releaseSecond, releaseThird] = await Promise.all([second, third]);

  expect(admitted).toEqual([2, 3]);
  expect(semaphore.running).toBe(3);
  expect(semaphore.pending).toBe(0);
  first();
  releaseSecond();
  releaseThird();
  expect(semaphore.running).toBe(0);
});

test("decreasing capacity drains active work before admitting queued work", async () => {
  const semaphore = new Semaphore(3);
  const releases = await Promise.all([semaphore.acquire(), semaphore.acquire(), semaphore.acquire()]);
  let admitted = false;
  const queued = semaphore.acquire().then((release) => { admitted = true; return release; });

  semaphore.resize(1);
  releases[0]!();
  releases[1]!();
  await Promise.resolve();
  expect(admitted).toBe(false);
  expect(semaphore.running).toBe(1);
  expect(semaphore.pending).toBe(1);

  releases[2]!();
  const releaseQueued = await queued;
  expect(admitted).toBe(true);
  expect(semaphore.running).toBe(1);
  releaseQueued();
  expect(semaphore.running).toBe(0);
});

test("resize rejects invalid capacities without changing the current limit", () => {
  const semaphore = new Semaphore(2);
  expect(() => semaphore.resize(0)).toThrow("Semaphore capacity must be positive");
  expect(() => semaphore.resize(1.5)).toThrow("Semaphore capacity must be positive");
  expect(semaphore.capacity).toBe(2);
});
