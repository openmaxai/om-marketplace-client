// Imported first by lock test children: before each lock file operation, a random pause of up to
// OM_MARKETPLACE_CLIENT_TEST_LOCK_DELAY_MS, and with OM_MARKETPLACE_CLIENT_TEST_LOCK_STEP=1 a report of the operation on
// stdout followed by a blocking wait for one line on stdin.
import fs from 'node:fs';
import path from 'node:path';
import { setLockHooks } from '../../src/state.js';

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

setLockHooks({
  step(op, file) {
    const max = Number(process.env.OM_MARKETPLACE_CLIENT_TEST_LOCK_DELAY_MS);
    if (max > 0) sleepMs(Math.random() * max);
    if (process.env.OM_MARKETPLACE_CLIENT_TEST_LOCK_STEP !== '1') return;
    fs.writeSync(1, `${JSON.stringify({ op, name: path.basename(file) })}\n`);
    const buf = Buffer.alloc(1);
    for (;;) {
      let n;
      try { n = fs.readSync(0, buf, 0, 1, null); } catch (err) { if (err.code === 'EAGAIN') { sleepMs(1); continue; } throw err; }
      if (n === 0) process.exit(1);
      if (buf[0] === 0x0a) return;
    }
  },
});
