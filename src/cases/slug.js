// src/cases/slug.js
const fs = require('fs');
const path = require('path');

const MAX = 48;

function slugify(title) {
  const s = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/g, '');
  return s || 'case';
}

function uniqueSlug(root, title) {
  const base = slugify(title);
  let candidate = base;
  for (let n = 2; fs.existsSync(path.join(root, candidate)); n += 1) {
    candidate = `${base.slice(0, MAX - String(n).length - 1)}-${n}`;
  }
  return candidate;
}

module.exports = { slugify, uniqueSlug };
