export const POLL_INTERVAL_MS = 5 * 60 * 1000;
// Base 50 min so that +20% jitter still stays within the 60 min reconcile bound.
export const RECONCILE_INTERVAL_MS = 50 * 60 * 1000;
export const JITTER_RATIO = 0.2;

// Returns baseMs scaled uniformly into [1 - JITTER_RATIO, 1 + JITTER_RATIO].
export function jittered(baseMs, rand = Math.random) {
  const r = Math.min(Math.max(Number(rand()) || 0, 0), 1);
  return Math.round(baseMs * (1 - JITTER_RATIO + 2 * JITTER_RATIO * r));
}

/**
 * Runs each task once at start, then again after a jittered delay measured
 * from the end of the previous run, so runs of one task never overlap.
 */
export function createScheduler(tasks, {
  rand = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger,
} = {}) {
  const timers = new Map();
  const inflight = new Set();
  let stopped = false;

  function schedule(task, delay) {
    if (stopped) return;
    const t = setTimer(() => run(task), delay);
    t?.unref?.();
    timers.set(task.name, t);
  }

  async function run(task) {
    timers.delete(task.name);
    if (stopped) return;
    const p = Promise.resolve()
      .then(() => task.run())
      .catch((err) => logger?.error(`${task.name} failed: ${err?.message || err}`));
    inflight.add(p);
    await p;
    inflight.delete(p);
    schedule(task, jittered(task.baseMs, rand));
  }

  return {
    start() {
      for (const task of tasks) schedule(task, 0);
    },
    async stop() {
      stopped = true;
      for (const t of timers.values()) clearTimer(t);
      timers.clear();
      await Promise.allSettled([...inflight]);
    },
  };
}
