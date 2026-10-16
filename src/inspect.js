import { Worker } from 'node:worker_threads';
import { InstallFailure } from './failure.js';
import { PackageError } from './pkg/zip.js';
import { SkillPolicyError } from './pkg/policy.js';

export const INSPECT_TIMEOUT_MS = 120_000;
const WORKER = new URL('./inspect-worker.js', import.meta.url);

function revive(e) {
  if (e.kind === 'package') return new PackageError(e.reason, e.detail);
  if (e.kind === 'policy') return new SkillPolicyError(e.violations, e.truncated);
  return new InstallFailure('CLIENT_INTERNAL', 'client internal error');
}

// Runs zip, hygiene, policy and frontmatter checks in a worker so the event loop never blocks. A timeout terminates the
// worker and fails with CLIENT_INTERNAL inspect_timeout. Resolves to { manifest, meta, files: [{ path, data }] }.
export function inspectInWorker(buf, { timeoutMs = INSPECT_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(buf);
    const w = new Worker(WORKER, { workerData: copy, transferList: [copy.buffer] });
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
    w.once('error', () => settle(reject, new InstallFailure('CLIENT_INTERNAL', 'client internal error')));
    w.once('exit', () => settle(reject, new InstallFailure('CLIENT_INTERNAL', 'client internal error')));
  });
}
