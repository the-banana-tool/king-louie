// src/history/sqlite-warning.js
// node:sqlite prints "ExperimentalWarning: SQLite is an experimental
// feature" when it is first loaded (recall spec §16). The two hosts drop that
// one warning before anything loads the history store; every other warning
// is emitted as before.

function isSqliteExperimentalWarning(warning, typeOrOptions) {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
  const name = warning && typeof warning === 'object' ? warning.name : null;
  const message = warning && typeof warning === 'object' ? warning.message : warning;
  return (type === 'ExperimentalWarning' || name === 'ExperimentalWarning') && /\bSQLite\b/.test(String(message));
}

function suppressSqliteExperimentalWarning(proc = process) {
  if (proc.__klSqliteWarningFiltered) return;
  const emitWarning = proc.emitWarning;
  proc.emitWarning = function emitWarningWithoutSqlite(warning, ...rest) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return undefined;
    return emitWarning.call(this, warning, ...rest);
  };
  proc.__klSqliteWarningFiltered = true;
}

module.exports = { suppressSqliteExperimentalWarning, isSqliteExperimentalWarning };
