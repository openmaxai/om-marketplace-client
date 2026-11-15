import fs from 'node:fs';
import path from 'node:path';
import { controlScript } from '../../src/activation.js';

// A fake zylos control queue: writes comm-bridge's c4-control.js into zylosDir. enqueue appends its arguments to
// `log` (one JSON line each) and answers "OK: enqueued control <n>"; get answers "status=<s>" from `${log}.status`
// (one status per line, by id; default `initial`), or "Error: not found" with exit 1; ack marks a pending one done.
export function fakeControl(zylosDir, log, { initial = 'pending' } = {}) {
  const script = controlScript(zylosDir);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `import fs from 'node:fs';
const log = ${JSON.stringify(log)};
const stFile = log + '.status';
const [cmd, ...args] = process.argv.slice(2);
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean) : []);
if (cmd === 'enqueue') {
  fs.appendFileSync(log, JSON.stringify([cmd, ...args]) + '\\n');
  fs.appendFileSync(stFile, ${JSON.stringify(initial)} + '\\n');
  console.log('OK: enqueued control ' + lines(log).length);
} else {
  const id = Number(args[args.indexOf('--id') + 1]);
  const st = lines(stFile);
  if (!st[id - 1]) { console.error('Error: not found'); process.exit(1); }
  if (cmd === 'get') console.log('status=' + st[id - 1]);
  if (cmd === 'ack') { if (st[id - 1] === 'pending') st[id - 1] = 'done'; fs.writeFileSync(stFile, st.join('\\n') + '\\n'); console.log('OK'); }
}
`);
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  return {
    enqueued: () => read(log).map((l) => JSON.parse(l)),
    statuses: () => read(`${log}.status`),
    set: (id, st) => {
      const all = read(`${log}.status`);
      all[id - 1] = st;
      fs.writeFileSync(`${log}.status`, `${all.join('\n')}\n`);
    },
  };
}
