#!/usr/bin/env node
// LongHaul, the session memory benchmark (docs/superpowers/specs/2026-09-25-session-memory-benchmark-design.md).
const { main } = require('../src/longhaul/cli');

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; }
);
