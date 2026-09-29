'use strict';
// `longhaul home`: where LongHaul keeps its data on this machine.
const { SUBDIRS } = require('../home');

module.exports = {
  options: {},
  async run(ctx) {
    ctx.stdout.write(`${ctx.home.root}\n`);
    for (const d of SUBDIRS) ctx.stdout.write(`  ${d}/\n`);
    return 0;
  }
};
