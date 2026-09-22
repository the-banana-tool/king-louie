'use strict';

const LOG_LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5, silent: 6 };

const LEVEL_METHODS = {
  trace: 'debug',
  debug: 'debug',
  info: 'log',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

let globalLevel = LOG_LEVELS[
  (process.env.KING_LOUIE_LOG_LEVEL || process.env.LOG_LEVEL || 'info').toLowerCase()
] ?? LOG_LEVELS.info;

let subsystemFilters = null;

// Extra destinations for log records, alongside the console (e.g. the service
// host's log file). Each sink receives
// { time, level, subsystem, message, meta, line } for every record that
// passes the level and subsystem filters. A sink that throws is ignored.
const sinks = new Set();

function addSink(fn) {
  if (typeof fn !== 'function') throw new Error('addSink requires a function');
  sinks.add(fn);
  return () => { sinks.delete(fn); };
}

function emitToSinks(level, subsystem, message, meta) {
  if (sinks.size === 0) return;
  const record = {
    time: new Date().toISOString(),
    level,
    subsystem,
    message,
    meta: meta || undefined,
    line: `[${subsystem}] ${message}${formatMeta(meta)}`
  };
  for (const sink of sinks) {
    try { sink(record); } catch { /* a broken sink must never break logging */ }
  }
}

function setLogLevel(level) {
  const resolved = LOG_LEVELS[level];
  if (resolved === undefined) throw new Error(`Unknown log level: ${level}`);
  globalLevel = resolved;
}

function getLogLevel() {
  return Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === globalLevel);
}

function setSubsystemFilter(filters) {
  subsystemFilters = filters ? new Set(filters) : null;
}

function isSubsystemEnabled(subsystem) {
  if (!subsystemFilters) return true;
  for (const filter of subsystemFilters) {
    if (subsystem === filter || subsystem.startsWith(filter + '/')) return true;
  }
  return false;
}

function formatMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const keys = Object.keys(meta);
  if (keys.length === 0) return '';
  const parts = keys.map(k => {
    const v = meta[k];
    return `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`;
  });
  return ` {${parts.join(', ')}}`;
}

function createLogger(subsystem) {
  const logger = {};

  for (const [level, consoleFn] of Object.entries(LEVEL_METHODS)) {
    const levelValue = LOG_LEVELS[level];
    logger[level] = function (message, meta) {
      if (levelValue < globalLevel) return;
      if (!isSubsystemEnabled(subsystem)) return;
      const tag = `[${subsystem}]`;
      const suffix = formatMeta(meta);
      if (suffix) {
        console[consoleFn](tag, message + suffix);
      } else {
        console[consoleFn](tag, message);
      }
      emitToSinks(level, subsystem, message, meta);
    };
  }

  logger.subsystem = subsystem;

  logger.isEnabled = function (level) {
    return LOG_LEVELS[level] >= globalLevel && isSubsystemEnabled(subsystem);
  };

  logger.child = function (name) {
    return createLogger(`${subsystem}/${name}`);
  };

  logger.withContext = function (meta) {
    return createBoundLogger(subsystem, meta);
  };

  return logger;
}

function createBoundLogger(subsystem, boundMeta) {
  const logger = {};

  for (const [level, consoleFn] of Object.entries(LEVEL_METHODS)) {
    const levelValue = LOG_LEVELS[level];
    logger[level] = function (message, meta) {
      if (levelValue < globalLevel) return;
      if (!isSubsystemEnabled(subsystem)) return;
      const merged = meta ? { ...boundMeta, ...meta } : boundMeta;
      const tag = `[${subsystem}]`;
      console[consoleFn](tag, message + formatMeta(merged));
      emitToSinks(level, subsystem, message, merged);
    };
  }

  logger.subsystem = subsystem;

  logger.isEnabled = function (level) {
    return LOG_LEVELS[level] >= globalLevel && isSubsystemEnabled(subsystem);
  };

  logger.child = function (name) {
    return createBoundLogger(`${subsystem}/${name}`, boundMeta);
  };

  logger.withContext = function (meta) {
    return createBoundLogger(subsystem, { ...boundMeta, ...meta });
  };

  return logger;
}

module.exports = {
  createLogger,
  setLogLevel,
  getLogLevel,
  setSubsystemFilter,
  addSink,
  LOG_LEVELS,
};
