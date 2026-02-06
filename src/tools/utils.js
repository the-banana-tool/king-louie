const path = require('path');

function normalizeForComparison(value) {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

function isPathWithin(basePath, targetPath) {
  const base = normalizeForComparison(basePath);
  const target = normalizeForComparison(targetPath);
  return target === base || target.startsWith(`${base}/`);
}

module.exports = {
  isPathWithin
};
