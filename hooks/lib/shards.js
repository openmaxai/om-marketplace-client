import { defaultZylosDir, ensureDeclarations, hooksPresent, syncHooks } from '../../src/shards.js';

// Declares the four template slot shards. zylos turns declarations into session-start hooks only during its hook sync,
// which also applies any other pending zylos settings change and may restart the agent, so it runs only while one of
// the four hooks is missing. Failure is reported but does not fail the hook.
export function installShards({ env = process.env, zylosDir = defaultZylosDir(env), sync = syncHooks, log = console.log, error = console.error } = {}) {
  try {
    const written = ensureDeclarations(zylosDir);
    log(`[om-marketplace-client] template shards ${written.length ? `declared: ${written.join(', ')}` : 'already declared'}`);
    if (hooksPresent(zylosDir)) {
      log('[om-marketplace-client] template session-start hooks already in place');
      return true;
    }
    log('[om-marketplace-client] running the zylos hook sync: the agent restarts once when idle; memory and context are kept');
    sync(zylosDir, { env });
    if (!hooksPresent(zylosDir)) throw new Error('the hook sync did not add the session-start hooks');
    return true;
  } catch (err) {
    error(`[om-marketplace-client] template shards not set up (${err.message}); expert templates will not be written`);
    return false;
  }
}
