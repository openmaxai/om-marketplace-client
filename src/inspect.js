import { Worker } from 'node:worker_threads';
import { InstallFailure } from './failure.js';
import { PackageError } from './pkg/zip.js';
import { SkillPolicyError } from './pkg/policy.js';

export const INSPECT_TIMEOUT_MS = 120_000;
const WORKER = new URL('./inspect-worker.js', import.meta.url);
// A package is at most 20 MiB zipped and 20 MiB unpacked; file data lives in Buffers outside the V8 heap.
export const WORKER_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 16, stackSizeMb: 4 });

function revive(e) {
  if (e.kind === 'package') return new PackageError(e.reason, e.detail);
  if (e.kind === 'policy') return new SkillPolicyError(e.violations, e.truncated);
  return new InstallFailure('CLIENT_INTERNAL', 'client internal error');
}

// Runs zip, hygiene, policy and frontmatter checks in a worker so the event loop never blocks. A timeout terminates the
// worker and fails with CLIENT_INTERNAL inspect_timeout; running out of worker memory fails with inspect_out_of_memory.
// Resolves to { manifest, meta, files: [{ path, data }] }.
export function inspectInWorker(buf, {
  timeoutMs = INSPECT_TIMEOUT_MS, signal = null, workerUrl = WORKER, resourceLimits = WORKER_LIMITS,
} = {}) {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(buf);
    const w = new Worker(workerUrl, { workerData: copy, transferList: [copy.buffer], resourceLimits });
    let timer;
    const settle = (fn, v) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      w.removeAllListeners();
      w.on('error', () => {});
      w.terminate().catch(() => {});
      fn(v);
    };
    const onAbort = () => settle(reject, new Error('inspection aborted'));
    timer = setTimeout(() => settle(reject, new InstallFailure('CLIENT_INTERNAL', 'inspect_timeout')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    w.once('message', (m) => {
      if (m.error) return settle(reject, revive(m.error));
      const blob = Buffer.from(m.blob);
      return settle(resolve, { manifest: m.manifest, meta: m.meta, files: m.index.map(([path, off, len]) => ({ path, data: blob.subarray(off, off + len) })) });
    });
    w.once('error', (err) => settle(reject, new InstallFailure('CLIENT_INTERNAL',
      err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'inspect_out_of_memory' : 'client internal error')));
    w.once('exit', () => settle(reject, new InstallFailure('CLIENT_INTERNAL', 'client internal error')));
  });
}
