import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import { processStartId, setLockHooks, verifiedLockHolder } from '../src/state.js';

const PID = 424242;
const START = 'boot-a:1000';

test('the lock holder is named only when pid, start time and boot id all match', (t) => {
  // The fake start id of any pid is START; the lock is only read, so the pid need not exist.
  setLockHooks({ startId: () => START });
  t.after(() => setLockHooks({ startId: (pid) => processStartId(pid) }));
  const dataDir = path.join(tmpHome(), 'd');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  const lock = (content) => fs.writeFileSync(path.join(dataDir, 'state', 'lock'), typeof content === 'string' ? content : JSON.stringify(content));

  assert.equal(verifiedLockHolder(dataDir), null, 'no lock');
  lock({ pid: PID, start: START });
  assert.equal(verifiedLockHolder(dataDir), PID);
  for (const [why, content] of [
    ['another start time, same boot', { pid: PID, start: 'boot-a:1001' }],
    ['same start time, another boot', { pid: PID, start: 'boot-b:1000' }],
    ['no start recorded', { pid: PID, start: null }],
    ['older plain-pid format', String(PID)],
    ['pid 1', { pid: 1, start: START }],
    ['this process', { pid: process.pid, start: START }],
    ['not a pid', { pid: 'x', start: START }],
    ['unparsable', '{'],
  ]) {
    lock(content);
    assert.equal(verifiedLockHolder(dataDir), null, why);
  }
  setLockHooks({ startId: () => null });
  lock({ pid: PID, start: START });
  assert.equal(verifiedLockHolder(dataDir), null, 'current start unknown');
  lock({ pid: PID, start: null });
  assert.equal(verifiedLockHolder(dataDir), null, 'both unknown');
});
