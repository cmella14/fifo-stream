'use strict';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function log(level, msg, meta = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  child: (defaultMeta) => ({
    debug: (msg, meta) => log('debug', msg, { ...defaultMeta, ...meta }),
    info:  (msg, meta) => log('info',  msg, { ...defaultMeta, ...meta }),
    warn:  (msg, meta) => log('warn',  msg, { ...defaultMeta, ...meta }),
    error: (msg, meta) => log('error', msg, { ...defaultMeta, ...meta }),
  }),
};

module.exports = logger;
