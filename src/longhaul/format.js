'use strict';
// Number formatting shared by LongHaul's outputs. A missing value prints
// differently per output (summary.md "—", report.md and the CLI "-", CSV
// empty), so it is a parameter.
const round8 = (n) => Number(n.toFixed(8));

function fixed(x, digits = 3, missing = '-') {
  return x === null || x === undefined || !Number.isFinite(x) ? missing : x.toFixed(digits);
}

function usd(x, missing = 'price unknown') {
  return x === null || x === undefined || !Number.isFinite(x) ? missing : `$${x.toFixed(4)}`;
}

module.exports = { round8, fixed, usd };
