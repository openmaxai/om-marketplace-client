import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESERVED_METADATA_KEYS } from './limits.js';

export const IM_TIMEOUT_MS = 30_000;
// First openmax release whose comm.send takes noRun; null until it is released.
export const OPENMAX_NORUN_MIN_VERSION = null;
const MAX_OUTPUT = 1024 * 1024;

export class ImError extends Error {
  // definite: the request was refused, so nothing was sent.
  constructor(message, { status = null, definite = false } = {}) {
    super(message);
    this.name = 'ImError';
    this.status = status;
    this.definite = definite;
  }
}

export const openmaxDir = (zylosDir) => path.join(zylosDir, '.claude', 'skills', 'openmax');
export const openmaxCommCli = (zylosDir) => path.join(openmaxDir(zylosDir), 'src', 'cli', 'comm.js');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)/;
// True when version a is at least b (major.minor.patch; anything unparsable is false).
export function versionAtLeast(a, b) {
  const x = SEMVER.exec(String(a ?? ''));
  const y = SEMVER.exec(String(b ?? ''));
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return true;
}

const unwrap = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'data' in v ? v.data : v);

// The CLI's JSON answer; openmax may also print request trace lines ("[rpc] ...") to stdout, which are skipped.
export function parseCliOutput(stdout) {
  return JSON.parse(String(stdout).split('\n').filter((line) => !line.startsWith('[rpc] ')).join('\n'));
}

function errorOf(err, stderr) {
  let status = null;
  try { status = Number(JSON.parse(String(stderr).trim().split('\n').at(-1)).status) || null; } catch { /* no JSON */ }
  const definite = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  const why = err.killed ? 'timed out' : status ? `HTTP ${status}` : `exit ${err.code ?? 'unknown'}`;
  return new ImError(why, { status, definite });
}

// Refuses a send body that carries a metadata key the IM service reserves.
export function assertNoReservedMetadata(body) {
  const meta = body?.metadata;
  const bad = RESERVED_METADATA_KEYS.filter((k) => (meta && typeof meta === 'object' && Object.hasOwn(meta, k)) || Object.hasOwn(body ?? {}, k));
  if (bad.length) throw new ImError(`reserved metadata key ${bad.join(', ')}`, { definite: true });
}

export function sendParams({ orgId, conversationId, text, clientMsgId, noRun = false }) {
  const body = { type: 'AGENT_TEXT', content: { content_type: 'text', body: { text }, attachments: [] } };
  assertNoReservedMetadata(body);
  return { org: orgId, conversationId, clientMsgId, body, ...(noRun ? { noRun: true } : {}) };
}

// The Agent's own OpenMax IM through the openmax component CLI, one process per call; every call names the org.
export function createOpenmaxIm({
  zylosDir, timeoutMs = IM_TIMEOUT_MS, run = execFile, noRunMinVersion = OPENMAX_NORUN_MIN_VERSION, now = Date.now,
}) {
  const cli = openmaxCommCli(zylosDir);
  const activity = path.join(openmaxDir(zylosDir), 'src', 'lib', 'activity');
  const call = (command, params) => new Promise((resolve, reject) => {
    run(process.execPath, [cli, command, JSON.stringify(params)], {
      cwd: path.dirname(path.dirname(path.dirname(cli))), timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true,
      env: { ...process.env, COCO_RPC_LOG: '0' },
    }, (err, stdout, stderr) => {
      if (err) return reject(errorOf(err, stderr));
      try { resolve(unwrap(parseCliOutput(stdout))); } catch { reject(new ImError('unreadable output')); }
    });
  });
  return {
    available() {
      try { return fs.statSync(cli).isFile(); } catch { return false; }
    },
    async createDm({ orgId, peerMemberId }) {
      const c = await call('comm.create_dm', { org: orgId, peerMemberId });
      if (typeof c?.id !== 'string' || !c.id) throw new ImError('create_dm returned no conversation id');
      return c.id;
    },
    async getConversation({ orgId, conversationId }) {
      return call('comm.get_conversation', { org: orgId, conversationId });
    },
    async memberList({ orgId, conversationId }) {
      const r = await call('comm.member_list', { org: orgId, conversationId });
      const list = Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : null;
      if (!list) throw new ImError('member_list returned no list');
      return list;
    },
    // True when the installed openmax is at least noRunMinVersion.
    supportsNoRun() {
      if (!noRunMinVersion) return false;
      try {
        return versionAtLeast(JSON.parse(fs.readFileSync(path.join(openmaxDir(zylosDir), 'package.json'), 'utf8')).version, noRunMinVersion);
      } catch { return false; }
    },
    // True when comm.send into the conversation would be taken as a run's reply: the run comm.send would select, read
    // from openmax's own activity store with its own selection code.
    async runInProgress({ conversationId }) {
      const { createRunStore } = await import(pathToFileURL(path.join(activity, 'run-store.js')).href);
      const { selectRun } = await import(pathToFileURL(path.join(activity, 'reply.js')).href);
      const store = createRunStore();
      const active = store.readActive();
      if (!active) return false;
      return Boolean(selectRun({ store, active, convId: conversationId, now: now() }).run);
    },
    // Plain text, no mentions: the message body is passed whole so the CLI resolves no @name.
    async sendText({ orgId, conversationId, text, clientMsgId, noRun = false }) {
      return call('comm.send', sendParams({ orgId, conversationId, text, clientMsgId, noRun }));
    },
  };
}
