import { BroadcastChannel, isMainThread } from 'node:worker_threads';

// Stand-in inspection worker that never finishes and beats on a channel until it is terminated. Inert when node --test
// loads it as a test file.
if (!isMainThread) {
  const beat = new BroadcastChannel('spin-worker');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    beat.postMessage(1);
    Atomics.wait(pause, 0, 0, 10);
  }
}
