import { defaultZylosDir, ensureDeclarations, syncHooks } from '../../src/shards.js';

// Declares the four template slot shards and runs the zylos hook sync, which is the only point where zylos turns
// declarations into session-start hooks. Failure is reported but does not fail the hook.
export function installShards({ env = process.env, zylosDir = defaultZylosDir(env), sync = syncHooks, log = console.log, error = console.error } = {}) {
  try {
    const written = ensureDeclarations(zylosDir);
    log(`[om-marketplace-client] template shards ${written.length ? `declared: ${written.join(', ')}` : 'already declared'}`);
    sync(zylosDir, { env });
    return true;
  } catch (err) {
    error(`[om-marketplace-client] template shards not set up (${err.message}); expert templates will not be written`);
    return false;
  }
}
