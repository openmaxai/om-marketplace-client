// Runs kill-parent.mjs for every scenario in both modes and fails on any broken final state.
// SCENS (comma list), TIMER_ROUNDS (default 40), MAXD and JOBS (default: CPU count) tune the run. Without MAXD the
// random kill window is sized to how long each scenario's round takes, so most timer rounds are really killed.
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SCENS = (process.env.SCENS ?? 'install,upgrade,disabled-upgrade,disable,enable,uninstall,refused').split(',');
const TIMER_ROUNDS = process.env.TIMER_ROUNDS ?? '40';
const JOBS = Number(process.env.JOBS ?? os.availableParallelism());
const PARENT = path.join(import.meta.dirname, 'kill-parent.mjs');

const SHORT = new Set(['disable', 'enable', 'uninstall']);
const maxd = (s) => process.env.MAXD ?? (SHORT.has(s) ? '60' : '400');
const jobs = SCENS.flatMap((s) => [{ SCEN: s, MODE: 'count', ROUNDS: '5000' }, { SCEN: s, MODE: 'timer', ROUNDS: TIMER_ROUNDS, MAXD: maxd(s) }]);
const run = (env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [PARENT], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('exit', (code) => {
    try { resolve(JSON.parse(out.trim().split('\n').at(-1))); } catch { resolve({ ...env, rounds: 0, ok: 0, bad: [{ why: `parent exited ${code}` }] }); }
  });
});

const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(JOBS, jobs.length) }, async () => {
  while (next < jobs.length) {
    const j = jobs[next++];
    const r = await run(j);
    results.push(r);
    console.log(`${r.SCEN.padEnd(17)} ${r.MODE.padEnd(5)} rounds ${String(r.rounds).padStart(4)}  ok ${String(r.ok).padStart(4)}  broken ${r.bad.length}`
      + `${r.MODE === 'count' ? `  completed unkilled at call ${r.completedAt ?? 'never'}` : `  killed ${r.killed}`}`);
  }
}));
const bad = results.flatMap((r) => r.bad.map((b) => ({ SCEN: r.SCEN, MODE: r.MODE, ...b })));
const incomplete = results.filter((r) => r.MODE === 'count' && r.completedAt == null);
const total = results.reduce((n, r) => n + r.rounds, 0);
console.log(`total rounds ${total}, broken ${bad.length}`);
for (const b of bad.slice(0, 20)) console.log(JSON.stringify(b));
for (const r of incomplete) console.log(`${r.SCEN} count sweep did not reach a completing child`);
process.exit(bad.length || incomplete.length ? 1 : 0);
