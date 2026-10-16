export const POLL_INTERVAL_MS = 5 * 60 * 1000;
export const JITTER_RATIO = 0.2;

// Returns baseMs scaled uniformly into [1 - JITTER_RATIO, 1 + JITTER_RATIO].
export function jittered(baseMs, rand = Math.random) {
  const r = Math.min(Math.max(Number(rand()) || 0, 0), 1);
  return Math.round(baseMs * (1 - JITTER_RATIO + 2 * JITTER_RATIO * r));
}

/**
 * Runs each task once at start, then again after a jittered delay measured
 * from the end of the previous run, so runs of one task never overlap. A run
 * resolving to { minDelayMs } is not rescheduled sooner than that.
 */
export function createScheduler(tasks, {
  rand = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger,
} = {}) {
  const timers = new Map();
  const inflight = new Set();
  const running = new Set();
  const again = new Set();
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
    running.add(task.name);
    const p = Promise.resolve()
      .then(() => task.run())
      .catch((err) => logger?.error(`${task.name} failed: ${err?.message || err}`));
    inflight.add(p);
    const res = await p;
    inflight.delete(p);
    running.delete(task.name);
    if (again.delete(task.name)) return schedule(task, 0);
    const min = Number(res?.minDelayMs);
    schedule(task, Math.max(jittered(task.baseMs, rand), Number.isFinite(min) ? min : 0));
  }

  return {
    start() {
      for (const task of tasks) schedule(task, 0);
    },
    // Runs a task now, or right after its current run; the regular cadence resumes from there.
    runNow(name) {
      const task = tasks.find((x) => x.name === name);
      if (!task || stopped) return;
      if (running.has(name)) return void again.add(name);
      clearTimer(timers.get(name));
      schedule(task, 0);
    },
    async stop() {
      stopped = true;
      for (const t of timers.values()) clearTimer(t);
      timers.clear();
      await Promise.allSettled([...inflight]);
    },
  };
}
