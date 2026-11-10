import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESERVED_METADATA_KEYS } from './limits.js';

export const IM_TIMEOUT_MS = 30_000;
// First openmax release whose comm.send takes noRun.
export const OPENMAX_NORUN_MIN_VERSION = '2.32.0';
const MAX_OUTPUT = 1024 * 1024;
// Pause before the one retry of a read-only call.
export const IM_RETRY_DELAY_MS = 1000;
// Longest CLI error or output excerpt kept in an ImError for the log.
const DETAIL_MAX = 200;

export class ImError extends Error {
  // definite: the request was refused, so nothing was sent. kind: what failed ('http', 'timeout', 'exit',
  // 'unreadable', 'answer' for a readable answer of the wrong shape, 'refused' for a call refused before running).
  constructor(message, { status = null, definite = false, kind = 'answer' } = {}) {
    super(message);
    this.name = 'ImError';
    this.status = status;
    this.definite = definite;
    this.kind = kind;
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

// A log line openmax prints to stdout next to its answer: "[rpc] ...", "[token] ...", any "[name] " prefix.
const TRACE_LINE = /^\[[\w.-]+\] /;

// The CLI's JSON answer: trace lines are skipped and the trailing JSON document is read. The answer is printed last,
// as one compact line or pretty-printed with only its first and last line unindented, so the document starts at the
// last unindented "{" or "[" line from which the rest parses.
export function parseCliOutput(stdout) {
  const lines = String(stdout).split('\n').filter((line) => !TRACE_LINE.test(line));
  let error = new SyntaxError('no JSON answer');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i][0] !== '{' && lines[i][0] !== '[') continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch (err) { error = err; }
  }
  throw error;
}

// Masks bearer tokens, JWTs and key=value secrets in CLI text kept for the log, on one line of at most DETAIL_MAX.
export function redact(text) {
  const one = String(text ?? '')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[redacted]')
    .replace(/\b((?:access_|refresh_|id_)?token|secret|password|api[_-]?key|authorization)("?\s*[:=]\s*"?)[^\s"',;}]+/gi, '$1$2[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > DETAIL_MAX ? `${one.slice(0, DETAIL_MAX)}...` : one;
}

// The CLI prints {"error", "status"?} as the last stderr line when a call fails; its error text is kept, redacted.
function errorOf(err, stderr) {
  let status = null;
  let detail = '';
  try {
    const last = JSON.parse(String(stderr).trim().split('\n').at(-1));
    status = Number(last?.status) || null;
    if (typeof last?.error === 'string') detail = redact(last.error);
  } catch { /* no JSON */ }
  const definite = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  const kind = err.killed ? 'timeout' : status ? 'http' : 'exit';
  const why = kind === 'timeout' ? 'timed out' : kind === 'http' ? `HTTP ${status}` : `exit ${err.code ?? 'unknown'}`;
  return new ImError(detail ? `${why}: ${detail}` : why, { status, definite, kind });
}

// A stdout that holds no JSON answer; its start is kept, redacted, for the log.
const unreadable = (stdout) => {
  const head = redact(String(stdout).slice(0, DETAIL_MAX * 2));
  return new ImError(head ? `unreadable output: ${head}` : 'unreadable output', { kind: 'unreadable' });
};

// Refuses a send body that carries a metadata key the IM service reserves.
export function assertNoReservedMetadata(body) {
  const meta = body?.metadata;
  const bad = RESERVED_METADATA_KEYS.filter((k) => (meta && typeof meta === 'object' && Object.hasOwn(meta, k)) || Object.hasOwn(body ?? {}, k));
  if (bad.length) throw new ImError(`reserved metadata key ${bad.join(', ')}`, { definite: true, kind: 'refused' });
}

export function sendParams({ orgId, conversationId, text, clientMsgId, noRun = false }) {
  const body = { type: 'AGENT_TEXT', content: { content_type: 'text', body: { text }, attachments: [] } };
  assertNoReservedMetadata(body);
  return { org: orgId, conversationId, clientMsgId, body, ...(noRun ? { noRun: true } : {}) };
}

// The Agent's own OpenMax IM through the openmax component CLI, one process per call; every call names the org. The
// read-only calls of the DM check (create_dm opens the DM only once) are tried again once after a failure that is not
// a refusal, such as unreadable output or a timeout; comm.send is never tried again.
export function createOpenmaxIm({
  zylosDir, timeoutMs = IM_TIMEOUT_MS, run = execFile, noRunMinVersion = OPENMAX_NORUN_MIN_VERSION, now = Date.now,
  retryDelayMs = IM_RETRY_DELAY_MS,
}) {
  const cli = openmaxCommCli(zylosDir);
  const activity = path.join(openmaxDir(zylosDir), 'src', 'lib', 'activity');
  const call = (command, params) => new Promise((resolve, reject) => {
    run(process.execPath, [cli, command, JSON.stringify(params)], {
      cwd: path.dirname(path.dirname(path.dirname(cli))), timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true,
      env: { ...process.env, COCO_RPC_LOG: '0' },
    }, (err, stdout, stderr) => {
      if (err) return reject(errorOf(err, stderr));
      try { resolve(unwrap(parseCliOutput(stdout))); } catch { reject(unreadable(stdout)); }
    });
  });
  const read = async (command, params) => {
    try {
      return await call(command, params);
    } catch (err) {
      if (err.definite) throw err;
      await new Promise((r) => { setTimeout(r, retryDelayMs); });
      return call(command, params);
    }
  };
  return {
    available() {
      try { return fs.statSync(cli).isFile(); } catch { return false; }
    },
    async createDm({ orgId, peerMemberId }) {
      // The service answers {conversation: {id, ...}, created}; a bare conversation is accepted too.
      const c = await read('comm.create_dm', { org: orgId, peerMemberId });
      const id = c?.conversation?.id ?? c?.id;
      if (typeof id !== 'string' || !id) throw new ImError('create_dm returned no conversation id');
      return id;
    },
    async getConversation({ orgId, conversationId }) {
      return read('comm.get_conversation', { org: orgId, conversationId });
    },
    async memberList({ orgId, conversationId }) {
      const r = await read('comm.member_list', { org: orgId, conversationId });
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
