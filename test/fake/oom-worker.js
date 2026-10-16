import { isMainThread } from 'node:worker_threads';

// Stand-in inspection worker that exhausts its heap. Inert when node --test loads it as a test file.
if (!isMainThread) {
  const hold = [];
  for (;;) hold.push(new Array(1e5).fill({ n: hold.length }));
}
