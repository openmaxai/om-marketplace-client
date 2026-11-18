#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, resolveDataDir } from './config.js';
import { CLIENT_VERSION } from './version.js';
import { createLogger } from './logger.js';
import { StateLockedError, readJson, stateScope, verifiedLockHolder } from './state.js';
import { createRuntime, pollRound } from './app.js';
import { EXIT, execute, spool } from './commands.js';
import { membershipMessage } from './orgs.js';
import { STALE_AFTER_MS } from './revocations.js';
import { AGENT_COMMANDS, SUBMIT_COMMANDS, runMarketCommand, runSubmitCommand } from './agent/commands.js';
import { startService } from './service.js';

const USAGE = `usage: market-client <command>
  start                     run post-install if needed, start the service under pm2 and check that it pulls from the market
  status [--json]           orgs, client version gate, last pulls, installed content, queue, alerts
  sync                      run one poll round now
  rollback <slug>           restore the version kept by the last upgrade
  enable <slug>             move a disabled skill back into the skills directory
  disable <slug>            move a skill out of the skills directory
  uninstall <slug>          remove a skill and its kept versions
  submit-skill <dir>        package a directory with SKILL.md and submit it as a new skill (org review; --personal: owner only)
  submit-template <file>    submit an expert template manifest (JSON) as a new template (org review; --personal: owner only)
  submissions [--json]      submissions made from this Agent
  search [<words>]          search skills listed for the organization [--category-id <id>] [--limit 1-20]
  install-permission        who may confirm installs on this Agent (in the workspace)
  request-install <skill>...  propose 1-3 skills (slug or id) for your owner to confirm in chat; --reason <text> once, or per skill
  install-requests          install requests made from this Agent, refreshed from the market [--state <state>]
  confirm-install <proposal_id> (all | <n|skill_id>...)  install what your owner chose in a direct conversation with you
  decline-install <proposal_id>  record that your owner declined
    both: --channel workspace|lark|telegram|other [--channel-detail <text>]
    --owner-message-id <id> and/or the owner's reply verbatim: --owner-message-file <path>, --owner-message-text-stdin or --owner-message-text <text>
submit options: --dry-run (local checks only), --personal (owner's personal shelf only, no review), --changelog <text>, --category-id <id>,
  --examples <file> (submit-skill: JSON array of up to 3 {title, prompt})
agent market commands take --json and --org <org_id> (default: the primary org)
start, sync, rollback, enable, disable and uninstall wait up to --wait <seconds> (default 900; start: 300) for a running service to answer`;
const SKILL_COMMANDS = new Set(['rollback', 'enable', 'disable', 'uninstall']);
const DEFAULT_WAIT_S = 900;
const START_WAIT_S = 300;
const POLL_MS = 250;
const RELOCK_MS = 2000;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// The service pid when the lock provably belongs to it; -1 when a live process whose identity cannot be checked holds
// it; null when no process holds it.
function lockHolder(dataDir) {
  const pid = verifiedLockHolder(dataDir);
  if (pid !== null) return pid;
  try {
    const other = Number(JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'lock'), 'utf8')).pid);
    if (!Number.isSafeInteger(other) || other <= 0 || other === process.pid) return null;
    process.kill(other, 0);
    return -1;
  } catch (err) {
    return err.code === 'EPERM' ? -1 : null;
  }
}

// Read-only view of the state files; takes no lock.
export function readStatus(dataDir, config, now = Date.now()) {
  const dir = path.join(dataDir, 'state', stateScope(config.bff_url, config.org_id, config.member_id));
  const doc = (name, fallback) => { try { return readJson(path.join(dir, `${name}.json`), fallback) ?? fallback; } catch { return fallback; } };
  const count = (sub) => { try { return fs.readdirSync(path.join(dir, sub)).filter((n) => n.endsWith('.json')).length; } catch { return 0; } };
  const st = doc('status', { alerts: {}, runs: {} });
  const marks = doc('orgs', {});
  const revs = doc('revocations', {});
  const queue = doc('intents', { queue: [] }).queue ?? [];
  const lastRev = revs.last_success_at ?? null;
  const orgs = Object.keys(config.orgs).map((id) => {
    const m = marks[id];
    const s = m ? (m.state === 'suspended' ? 'suspended' : 'invalid') : 'ok';
    return { org_id: id, primary: id === config.org_id, state: s, since: m?.since ?? null, message: m ? membershipMessage(id, s, id === config.org_id) : null };
  });
  const byStatus = {};
  for (const q of queue) byStatus[q.status] = (byStatus[q.status] ?? 0) + 1;
  return {
    version: CLIENT_VERSION,
    service: lockHolder(dataDir),
    orgs,
    too_old: doc('gate', {}).too_old ?? null,
    runs: st.runs ?? {},
    revocations: {
      last_success_at: lastRev,
      stale: Boolean(st.alerts?.revocations_stale) || (lastRev !== null && now - Date.parse(lastRev) > STALE_AFTER_MS),
    },
    skills: Object.entries(doc('installs', {})).map(([id, r]) => ({
      skill_id: id, slug: r.slug, version_no: r.version_no, state: r.state, org_id: r.org_id, rollback_version_no: r.rollback?.version_no ?? null,
    })),
    templates: Object.values(doc('adoptions', {})).filter((a) => a.state !== 'removed').map((a) => ({
      adoption_id: a.adoption_id, template: a.template ?? a.template_id, version: a.version ?? null, state: a.state, org_id: a.org_id,
    })),
    queue: { total: queue.length, by_status: byStatus },
    outbox: count('outbox') + Object.keys(doc('template_reports', {})).length,
    last_reconcile: doc('reconcile', {}).last ?? null,
    alerts: Object.fromEntries(Object.entries(st.alerts ?? {}).filter(([k]) => !k.startsWith('org_membership:'))),
  };
}

export function renderStatus(s) {
  const out = [`om-marketplace-client ${s.version}`];
  out.push(`service: ${s.service === null ? 'not running' : s.service > 0 ? `running (pid ${s.service})` : 'state lock held by a process that cannot be identified'}`);
  out.push('orgs:');
  for (const o of s.orgs) {
    out.push(`  ${o.org_id}${o.primary ? ' (primary)' : ''}: ${o.state}${o.since ? ` since ${o.since}` : ''}`);
    if (o.message) out.push(`    ${o.message}`);
  }
  out.push(s.too_old
    ? `client version: TOO OLD (${s.too_old.reason}${s.too_old.min_version ? `, minimum ${s.too_old.min_version}` : ''}) since ${s.too_old.since}; new orders are not executed until \`zylos upgrade om-marketplace-client\``
    : 'client version: accepted');
  const runs = Object.entries(s.runs).map(([k, r]) => `${k} ${r.outcome} at ${r.at}`);
  out.push(`last runs: ${runs.length ? runs.join('; ') : 'none yet'}`);
  out.push(`revocations last pulled: ${s.revocations.last_success_at ?? 'never'}${s.revocations.stale ? ' (STALE: no successful pull for over 24 h)' : ''}`);
  out.push(`skills (${s.skills.length}):`);
  for (const k of s.skills) {
    out.push(`  ${k.slug} v${k.version_no} ${k.state}${k.rollback_version_no ? `, v${k.rollback_version_no} kept for rollback` : ''} (org ${k.org_id})`);
  }
  out.push(`templates (${s.templates.length}):`);
  for (const t of s.templates) out.push(`  ${t.template}${t.version ? ` ${t.version}` : ''} ${t.state} (adoption ${t.adoption_id})`);
  const by = Object.entries(s.queue.by_status).map(([k, n]) => `${n} ${k}`).join(', ');
  out.push(`queue: ${s.queue.total} order(s)${by ? ` (${by})` : ''}; outbox: ${s.outbox} report(s) waiting`);
  if (s.last_reconcile) out.push(`last reconcile: ${s.last_reconcile.outcome} at ${s.last_reconcile.at}`);
  const alerts = Object.entries(s.alerts);
  out.push(`alerts (${alerts.length}):`);
  for (const [k, a] of alerts) out.push(`  ${k}: ${a.message} (since ${a.since})`);
  return out.join('\n');
}

// What a signal does while a command runs: locally it aborts what can be aborted and lets the current step finish, and
// a second SIGINT exits at once (every step is journaled, so the next start completes or undoes it); while waiting for
// the service it withdraws the request when the service has not taken it yet, and exits.
export function commandSignals(ctx, { abort, sp, print, exit = (code) => process.exit(code) }) {
  return (sig) => {
    abort.abort();
    if (ctx.local) {
      if (ctx.interrupted && sig === 'SIGINT') {
        print('interrupted again; exiting now');
        exit(130);
        return;
      }
      if (!ctx.interrupted) print(`interrupted; finishing the current step first${sig === 'SIGINT' ? ' (Ctrl-C again to exit now)' : ''}`);
      ctx.interrupted = true;
      return;
    }
    if (ctx.reqId && sp.withdraw(ctx.reqId)) print('request withdrawn');
    else if (ctx.reqId) print('the service already started the request; see `market-client status`');
    exit(130);
  };
}

// Runs the command with the state lock, or hands it to the lock holder (the service) and waits for its answer.
async function runCommand({ cmd, arg, config, dataDir, logger, waitMs, print }) {
  const abort = new AbortController();
  const sp = spool(dataDir);
  const ctx = { reqId: null, local: false, interrupted: false };
  const onSignal = commandSignals(ctx, { abort, sp, print });
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const r = await commandLoop();
    return ctx.interrupted ? { ...r, code: 130 } : r;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  async function commandLoop() {
    const deadline = Date.now() + waitMs;
    let nextLock = 0;
    for (;;) {
      if (Date.now() >= nextLock) {
        nextLock = Date.now() + RELOCK_MS;
        let runtime = null;
        try {
          runtime = createRuntime({ config, dataDir, logger, signal: abort.signal });
        } catch (err) {
          if (!(err instanceof StateLockedError)) throw err;
        }
        if (runtime) {
          ctx.local = true;
          try {
            if (ctx.reqId && !sp.withdraw(ctx.reqId)) return sp.take(ctx.reqId) ?? { code: EXIT.FAILED, message: 'the service stopped while running the request; check status' };
            return await execute(runtime, { cmd, arg }, pollRound(logger, runtime));
          } finally {
            runtime.state.close();
          }
        }
        if (!ctx.reqId) {
          ctx.reqId = sp.submit(cmd, arg);
          print('the service holds the state lock; the request was handed to it');
        }
      }
      const r = sp.take(ctx.reqId);
      if (r) return r;
      if (Date.now() >= deadline) {
        return sp.withdraw(ctx.reqId)
          ? { code: EXIT.BUSY, message: 'the service did not take the request in time; nothing was done' }
          : { code: EXIT.BUSY, message: 'the request is still running in the service; check `market-client status` later' };
      }
      await sleep(POLL_MS);
    }
  }
}

// Largest owner reply read from stdin or a file.
export const MAX_OWNER_MESSAGE_BYTES = 64 * 1024;
export class InputError extends Error {}

const utf8 = (buf, what) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new InputError(`${what} is not valid UTF-8`);
  }
};

// Reads stdin, stopping as soon as it passes MAX_OWNER_MESSAGE_BYTES.
export const readAllStdin = async (stream = process.stdin) => {
  const chunks = [];
  let size = 0;
  for await (const c of stream) {
    size += c.length;
    if (size > MAX_OWNER_MESSAGE_BYTES) throw new InputError(`the owner's reply on stdin is over ${MAX_OWNER_MESSAGE_BYTES} bytes`);
    chunks.push(c);
  }
  return utf8(Buffer.concat(chunks), 'the owner\'s reply on stdin');
};

// Reads the open file in chunks, refusing as soon as it passes MAX_OWNER_MESSAGE_BYTES.
export function readCapped(fd, readSync = fs.readSync) {
  const buf = Buffer.alloc(MAX_OWNER_MESSAGE_BYTES + 1);
  let n = 0;
  for (;;) {
    const r = readSync(fd, buf, n, buf.length - n, null);
    if (r === 0) return buf.subarray(0, n);
    n += r;
    if (n > MAX_OWNER_MESSAGE_BYTES) throw new InputError(`--owner-message-file is over ${MAX_OWNER_MESSAGE_BYTES} bytes`);
  }
}

// The only directory a reply file may be in (directly). Fixed, never taken from the environment.
export const TRUSTED_TMP = '/tmp';

// A shared temp directory is safe only when root-owned, world-writable and sticky (others cannot replace our file).
export function trustedDirProblem(st) {
  if (!st.isDirectory()) return 'is not a directory';
  if (st.uid !== 0) return 'is not owned by root';
  if ((st.mode & 0o1002) !== 0o1002) return 'is not world-writable with the sticky bit';
  return null;
}

// A reply file must be a regular file of this user with no other name (a hard link could expose any file).
export function replyFileProblem(st, uid) {
  if (!st.isFile()) return '--owner-message-file is not a regular file';
  if (uid !== null && st.uid !== uid) return '--owner-message-file is not owned by this user';
  if (st.nlink !== 1) return 'reply file has other links';
  return null;
}

// Real path of an open file: /proc on Linux; elsewhere the name's real path, accepted only if it is the same file.
function fdRealPath(fd, name, st) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    const real = fs.realpathSync(name);
    const again = fs.statSync(real);
    if (again.dev !== st.dev || again.ino !== st.ino) throw new InputError('--owner-message-file changed while it was checked');
    return real;
  }
}

// The owner's reply from a temp file the Agent just wrote. Everything is decided on the opened descriptor: opened
// without following a final symbolic link and without blocking (a FIFO cannot hang the command), it must be a regular
// file of this user located directly in the trusted temp directory.
export function readOwnerMessageFile(file, { trustedDir = TRUSTED_TMP, uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  const fail = (err) => new InputError(err.code === 'ELOOP' ? '--owner-message-file is a symbolic link'
    : `--owner-message-file cannot be read (${err.code || 'error'})`);
  let trusted;
  try {
    trusted = fs.realpathSync(trustedDir);
    const problem = trustedDirProblem(fs.statSync(trusted));
    if (problem) throw new InputError(`the temp directory ${trusted} ${problem}`);
  } catch (err) {
    if (err instanceof InputError) throw err;
    throw new InputError(`the temp directory ${trustedDir} cannot be used (${err.code || 'error'})`);
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    throw fail(err);
  }
  try {
    const st = fs.fstatSync(fd);
    const problem = replyFileProblem(st, uid);
    if (problem) throw new InputError(problem);
    let real;
    try { real = fdRealPath(fd, file, st); } catch (err) {
      if (err instanceof InputError) throw err;
      throw fail(err);
    }
    if (path.dirname(real) !== trusted) throw new InputError(`--owner-message-file must be a temp file you wrote, directly in ${trusted}`);
    if (st.size > MAX_OWNER_MESSAGE_BYTES) throw new InputError(`--owner-message-file is over ${MAX_OWNER_MESSAGE_BYTES} bytes`);
    let buf;
    try {
      buf = readCapped(fd);
    } catch (err) {
      if (err instanceof InputError) throw err;
      throw fail(err);
    }
    return utf8(buf, '--owner-message-file');
  } finally {
    fs.closeSync(fd);
  }
}

export async function main(argv = process.argv.slice(2), { env = process.env, print = (l) => process.stdout.write(`${l}\n`), readStdin = readAllStdin, stdinIsTTY = () => process.stdin.isTTY === true,
} = {}) {
  const [cmd, ...rest] = argv;
  const opts = { json: false, wait: cmd === 'start' ? START_WAIT_S : DEFAULT_WAIT_S, dryRun: false };
  const VALUE_OPTS = {
    '--changelog': 'changelog', '--category-id': 'categoryId', '--examples': 'examples', '--org': 'org', '--reason': 'reason', '--limit': 'limit', '--state': 'state',
    '--channel': 'channel', '--channel-detail': 'channelDetail', '--owner-message-id': 'ownerMessageId', '--owner-message-text': 'ownerMessageText',
    '--owner-message-file': 'ownerMessageFile',
  };
  const submit = AGENT_COMMANDS.has(cmd);
  const pos = [];
  let badOpt = false;
  let textFromStdin = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') opts.json = true;
    else if (submit && rest[i] === '--owner-message-text-stdin') {
      if (textFromStdin) badOpt = true;
      textFromStdin = true;
    }
    else if (rest[i] === '--wait') opts.wait = Number(rest[++i]);
    else if (SUBMIT_COMMANDS.has(cmd) && rest[i] === '--dry-run') opts.dryRun = true;
    else if ((cmd === 'submit-skill' || cmd === 'submit-template') && rest[i] === '--personal') {
      if (opts.personal) badOpt = true;
      opts.personal = true;
    }
    else if (submit && VALUE_OPTS[rest[i]]) {
      if (i + 1 >= rest.length) badOpt = true;
      const k = VALUE_OPTS[rest[i]];
      // Only --reason may be repeated; any other repeated option is a usage error.
      if (k !== 'reason' && Object.hasOwn(opts, k)) badOpt = true;
      const v = rest[++i];
      opts[k] = k === 'reason' ? [...(opts.reason ?? []), v] : v;
    } else pos.push(rest[i]);
  }
  const variadic = { search: [0, Infinity], 'request-install': [1, 3], 'confirm-install': [2, 1 + 3] }[cmd];
  const arity = ['status', 'sync', 'start', 'submissions', 'install-requests', 'install-permission'].includes(cmd) ? 0
    : variadic ? (pos.length >= variadic[0] && pos.length <= variadic[1] ? pos.length : -1)
      : SKILL_COMMANDS.has(cmd) || submit ? 1 : -1;
  if ([textFromStdin, opts.ownerMessageText != null, opts.ownerMessageFile != null].filter(Boolean).length > 1) badOpt = true;
  if (badOpt || arity !== pos.length || !(opts.wait >= 0)) {
    print(USAGE);
    return cmd === 'help' || cmd === '--help' ? EXIT.OK : EXIT.USAGE;
  }
  const arg = pos[0];
  const dataDir = resolveDataDir(env);
  if (cmd === 'start') {
    const logger = createLogger(env.MARKET_CLIENT_LOG_LEVEL || 'warn', { log: (l) => process.stderr.write(`${l}\n`), error: (l) => process.stderr.write(`${l}\n`) });
    try {
      const r = await startService({
        dataDir,
        print,
        readStatus: (config) => readStatus(dataDir, config),
        sync: (config) => runCommand({ cmd: 'sync', arg: null, config, dataDir, logger, waitMs: opts.wait * 1000, print }),
      });
      print(r.message);
      return r.code;
    } catch (err) {
      print(`start failed: ${err.message}`);
      return EXIT.FAILED;
    }
  }
  if (textFromStdin || opts.ownerMessageFile != null) {
    try {
      if (textFromStdin && stdinIsTTY()) throw new InputError('--owner-message-text-stdin needs the reply piped in; stdin is a terminal');
      const raw = textFromStdin ? await readStdin() : readOwnerMessageFile(opts.ownerMessageFile);
      // One trailing newline (from a heredoc or an editor) is not part of the owner's reply.
      opts.ownerMessageText = raw.replace(/\r?\n$/, '');
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      print(opts.json ? JSON.stringify({ ok: false, error: 'usage', message: err.message }, null, 2) : `${cmd} refused: ${err.message}`);
      return EXIT.USAGE;
    }
    delete opts.ownerMessageFile;
  }
  let config;
  try {
    config = loadConfig(dataDir);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    print(`configuration error: ${err.message}`);
    return EXIT.CONFIG;
  }
  if (cmd === 'status') {
    const s = readStatus(dataDir, config);
    print(opts.json ? JSON.stringify(s, null, 2) : renderStatus(s));
    return EXIT.OK;
  }
  const logger = createLogger(env.MARKET_CLIENT_LOG_LEVEL || 'warn', { log: (l) => process.stderr.write(`${l}\n`), error: (l) => process.stderr.write(`${l}\n`) });
  if (submit) {
    try {
      return SUBMIT_COMMANDS.has(cmd)
        ? await runSubmitCommand(cmd, pos[0], opts, { config, dataDir, print, logger })
        : await runMarketCommand(cmd, cmd === 'search' ? (pos.length ? [pos.join(' ')] : []) : pos, opts, { config, dataDir, print, logger });
    } catch (err) {
      print(`${cmd} failed: ${err.message}`);
      return EXIT.FAILED;
    }
  }
  try {
    const r = await runCommand({ cmd, arg, config, dataDir, logger, waitMs: opts.wait * 1000, print });
    print(r.message);
    return r.code;
  } catch (err) {
    print(`${cmd} failed: ${err.message}`);
    return EXIT.FAILED;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
