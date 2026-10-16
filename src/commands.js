import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './state.js';

export const COMMANDS = new Set(['sync', 'rollback', 'enable', 'disable', 'uninstall']);
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, REFUSED: 3, BUSY: 4, CONFIG: 78 });
const STALE_REQUEST_MS = 60 * 60 * 1000;

const result = (code, message) => ({ code, message });

function skillIdOf(skills, ref) {
  const recs = skills.installed();
  if (Object.hasOwn(recs, ref)) return ref;
  return Object.keys(recs).find((id) => recs[id].slug === ref) ?? null;
}

const REFUSALS = {
  none: 'no previous version is kept for this skill',
  revoked: 'the previous version is revoked',
  busy: 'an order or report for this skill is still in progress; try again after the next round',
  quarantined: 'the installed version is revoked and quarantined; install another version from the workbench',
};

// Runs one command against an open runtime (the caller holds the state lock). `round` runs one poll round.
export async function execute(runtime, { cmd, arg }, round) {
  if (cmd === 'sync') {
    await round();
    return result(EXIT.OK, 'poll round finished');
  }
  const { skills } = runtime;
  const skillId = skillIdOf(skills, arg);
  if (!skillId) return result(EXIT.REFUSED, `skill ${arg} is not installed by the market client`);
  const slug = skills.installed()[skillId].slug;
  if (cmd === 'rollback') {
    const r = skills.rollback(skillId);
    if (r !== 'done') return result(EXIT.REFUSED, `rollback of ${slug} refused: ${REFUSALS[r]}`);
    const rec = skills.installed()[skillId];
    let reported = 'reported to the market';
    try {
      const rr = await runtime.reconcile.run();
      if (rr.outcome !== 'ok') reported = `market report ${rr.outcome}; retried by the next reconcile`;
    } catch (err) {
      reported = `market report failed (${err.message}); retried by the next reconcile`;
    }
    return result(EXIT.OK, `${slug} rolled back to version ${rec.version_no}; ${reported}`);
  }
  const r = cmd === 'uninstall' ? await skills.uninstall(skillId) : await skills.setEnabled(skillId, cmd === 'enable');
  const done = { enable: 'enabled', disable: 'disabled', uninstall: 'uninstalled' }[cmd];
  if (r === 'refused') return result(EXIT.REFUSED, `${slug} is quarantined because its version was revoked; it cannot be enabled`);
  if (r === 'deferred') return result(EXIT.OK, `${slug} ${done}; the market report is queued and resent on the next round`);
  return result(EXIT.OK, `${slug} ${done}; reported to the market`);
}

// Requests from the CLI to the running service: <dir>/<id>.json, renamed to <id>.run when claimed, answered by
// <id>.result.json. Only the state lock holder claims requests.
export function spool(dataDir) {
  const dir = path.join(dataDir, 'cli');
  const file = (id, ext) => path.join(dir, `${id}.${ext}`);
  const names = () => { try { return fs.readdirSync(dir); } catch { return []; } };
  const ids = (ext) => names().filter((n) => n.endsWith(`.${ext}`) && !n.endsWith('.result.json')).map((n) => n.slice(0, -ext.length - 1));

  return {
    pending: () => ids('json').length > 0,

    submit(cmd, arg) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      writeJsonAtomic(file(id, 'json'), { cmd, arg: arg ?? null, at: new Date().toISOString() });
      return id;
    },

    // True when the request was still unclaimed and is now withdrawn.
    withdraw(id) {
      try { fs.unlinkSync(file(id, 'json')); return true; } catch { return false; }
    },

    take(id) {
      const r = readJson(file(id, 'result.json'), null);
      if (r) fs.rmSync(file(id, 'result.json'), { force: true });
      return r;
    },

    // Claims every waiting request. Requests claimed by a holder that died are answered as interrupted.
    claim(now = Date.now()) {
      for (const id of ids('run')) {
        writeJsonAtomic(file(id, 'result.json'), result(EXIT.FAILED, 'interrupted by a service restart; check status'));
        fs.rmSync(file(id, 'run'), { force: true });
      }
      for (const n of names().filter((x) => x.endsWith('.result.json'))) {
        try { if (now - fs.statSync(path.join(dir, n)).mtimeMs > STALE_REQUEST_MS) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* gone */ }
      }
      const out = [];
      for (const id of ids('json').sort()) {
        let req;
        try {
          fs.renameSync(file(id, 'json'), file(id, 'run'));
          req = readJson(file(id, 'run'), null);
        } catch { continue; }
        if (!req || !COMMANDS.has(req.cmd) || !(now - Date.parse(req.at) < STALE_REQUEST_MS)) {
          fs.rmSync(file(id, 'run'), { force: true });
          continue;
        }
        out.push({ id, ...req });
      }
      return out;
    },

    answer(id, res) {
      writeJsonAtomic(file(id, 'result.json'), res);
      fs.rmSync(file(id, 'run'), { force: true });
    },
  };
}
