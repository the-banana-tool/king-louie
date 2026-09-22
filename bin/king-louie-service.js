#!/usr/bin/env node
const { main } = require('../src/service/cli');

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; if (process.connected) process.disconnect(); },
  (err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; }
);
