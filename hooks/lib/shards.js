import { defaultZylosDir, ensureDeclarations, hooksPresent, runtimeOf, syncHooks } from '../../src/shards.js';

// Declares the four template slot shards. zylos turns declarations into session-start hooks only during its hook sync,
// which also applies any other pending zylos settings change, so it runs only while one of the four hooks is missing.
// On Claude the sync restarts the agent once when idle. On Codex the sync rewrites .codex/hooks.json only when the Codex
// config changed and schedules no restart; the hooks are added when the Codex session next starts, so missing hooks
// after the sync are not a failure there. Failure is reported but does not fail the hook.
export function installShards({ env = process.env, zylosDir = defaultZylosDir(env), sync = syncHooks, log = console.log, error = console.error } = {}) {
  try {
    const written = ensureDeclarations(zylosDir);
    log(`[om-marketplace-client] template shards ${written.length ? `declared: ${written.join(', ')}` : 'already declared'}`);
    if (hooksPresent(zylosDir)) {
      log('[om-marketplace-client] template session-start hooks already in place');
      return true;
    }
    const codex = runtimeOf(zylosDir) === 'codex';
    log(codex
      ? '[om-marketplace-client] running the zylos hook sync: expert templates take effect when the Codex session next starts'
      : '[om-marketplace-client] running the zylos hook sync: the agent restarts once when idle; memory and context are kept');
    sync(zylosDir, { env });
    if (hooksPresent(zylosDir)) return true;
    if (codex) {
      log('[om-marketplace-client] template session-start hooks are added when the Codex session next starts; expert templates are written after that');
      return true;
    }
    throw new Error('the hook sync did not add the session-start hooks');
  } catch (err) {
    error(`[om-marketplace-client] template shards not set up (${err.message}); expert templates will not be written`);
    return false;
  }
}
