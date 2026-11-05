import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const IM_TIMEOUT_MS = 30_000;
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

export const openmaxCommCli = (zylosDir) => path.join(zylosDir, '.claude', 'skills', 'openmax', 'src', 'cli', 'comm.js');

const unwrap = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'data' in v ? v.data : v);

function errorOf(err, stderr) {
  let status = null;
  try { status = Number(JSON.parse(String(stderr).trim().split('\n').at(-1)).status) || null; } catch { /* no JSON */ }
  const definite = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  const why = err.killed ? 'timed out' : status ? `HTTP ${status}` : `exit ${err.code ?? 'unknown'}`;
  return new ImError(why, { status, definite });
}

// The Agent's own OpenMax IM through the openmax component CLI, one process per call; every call names the org.
export function createOpenmaxIm({ zylosDir, timeoutMs = IM_TIMEOUT_MS, run = execFile }) {
  const cli = openmaxCommCli(zylosDir);
  const call = (command, params) => new Promise((resolve, reject) => {
    run(process.execPath, [cli, command, JSON.stringify(params)], {
      cwd: path.dirname(path.dirname(path.dirname(cli))), timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) return reject(errorOf(err, stderr));
      try { resolve(unwrap(JSON.parse(stdout))); } catch { reject(new ImError('unreadable output')); }
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
    // Plain text, no mentions: the message body is passed whole so the CLI resolves no @name.
    async sendText({ orgId, conversationId, text, clientMsgId }) {
      return call('comm.send', {
        org: orgId, conversationId, clientMsgId,
        body: { type: 'AGENT_TEXT', content: { content_type: 'text', body: { text }, attachments: [] } },
      });
    },
  };
}
