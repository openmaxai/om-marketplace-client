const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info', sink = console) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, out) => (msg) => {
    if (LEVELS[lvl] >= min) out(`${new Date().toISOString()} [${lvl}] ${msg}`);
  };
  return {
    debug: emit('debug', sink.log),
    info: emit('info', sink.log),
    warn: emit('warn', sink.error),
    error: emit('error', sink.error),
  };
}
