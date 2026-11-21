const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
let current = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

export function setLogLevel(level) {
  current = LEVELS[level] ?? LEVELS.info;
}

function out(level, scope, msg, extra) {
  if (LEVELS[level] < current) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra !== undefined) fn(line, extra);
  else fn(line);
}

export function createLogger(scope) {
  return {
    debug: (m, e) => out('debug', scope, m, e),
    info: (m, e) => out('info', scope, m, e),
    warn: (m, e) => out('warn', scope, m, e),
    error: (m, e) => out('error', scope, m, e),
  };
}
