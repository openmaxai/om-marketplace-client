import { parentPort, workerData } from 'node:worker_threads';
import { inspectPackage } from './pkg/hygiene.js';
import { PackageError } from './pkg/zip.js';
import { SkillPolicyError } from './pkg/policy.js';

// File contents go back in one transferred buffer: posting views of the zip buffer would copy it once per file.
try {
  const { manifest, meta, files } = inspectPackage(Buffer.from(workerData.buffer, workerData.byteOffset, workerData.byteLength));
  const blob = new Uint8Array(files.reduce((n, f) => n + f.data.length, 0));
  const index = [];
  let off = 0;
  for (const f of files) {
    blob.set(f.data, off);
    index.push([f.path, off, f.data.length]);
    off += f.data.length;
  }
  parentPort.postMessage({ manifest, meta, blob: blob.buffer, index }, [blob.buffer]);
} catch (err) {
  let error = { kind: 'internal' };
  if (err instanceof PackageError) error = { kind: 'package', reason: err.reason, detail: err.detail };
  else if (err instanceof SkillPolicyError) error = { kind: 'policy', violations: err.violations, truncated: err.truncated };
  parentPort.postMessage({ error });
}
