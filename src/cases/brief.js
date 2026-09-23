// src/cases/brief.js
// brief.md: YAML front matter (structured fields) + free prose (spec §4.3).
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const BRIEF_FIELDS = new Set([
  'objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried',
  'resources', 'deadline', 'materiality'
]);
const USER_ONLY_FIELDS = new Set(['why', 'hardConstraints', 'alreadyTried']);
const ARRAY_FIELDS = new Set(['successCriteria', 'hardConstraints', 'alreadyTried']);
const OBJECT_FIELDS = new Set(['resources', 'materiality']);
const GATING_REQUIRED = ['objective', 'why', 'successCriteria'];

class BriefError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BriefError';
  }
}

function validate(field, value) {
  if (!BRIEF_FIELDS.has(field)) {
    throw new BriefError(`Unknown brief field "${field}". Fields: ${[...BRIEF_FIELDS].join(', ')}.`);
  }
  if (ARRAY_FIELDS.has(field)) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw new BriefError(`"${field}" must be an array of strings.`);
    }
  } else if (OBJECT_FIELDS.has(field)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BriefError(`"${field}" must be an object.`);
    }
  } else if (field === 'deadline') {
    if (value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      throw new BriefError('"deadline" must be YYYY-MM-DD or null.');
    }
  } else if (typeof value !== 'string') {
    throw new BriefError(`"${field}" must be a string.`);
  }
}

function checkProvenance(field, provenance) {
  if (USER_ONLY_FIELDS.has(field) && provenance !== 'user') {
    throw new BriefError(`"${field}" can only be set from something the owner said (provenance "user"). Ask the owner instead of filling it in.`);
  }
}

const isEmpty = (v) => v === undefined || v === null
  || (typeof v === 'string' && !v.trim())
  || (Array.isArray(v) && v.length === 0);

class Brief {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, 'brief.md');
  }

  read() {
    const text = fs.readFileSync(this.path, 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    if (lines[0] !== '---') return { data: {}, body: text };
    const end = lines.indexOf('---', 1);
    if (end === -1) return { data: {}, body: text };
    let data;
    try {
      data = yaml.load(lines.slice(1, end).join('\n')) || {};
    } catch (err) {
      throw new BriefError(`brief.md front matter is not valid YAML: ${err.message}`);
    }
    return { data, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
  }

  _write(data, body) {
    fs.writeFileSync(this.path, `---\n${yaml.dump(data).trimEnd()}\n---\n\n${body}`);
  }

  update(field, value, { provenance } = {}) {
    validate(field, value);
    checkProvenance(field, provenance);
    const { data, body } = this.read();
    data[field] = value;
    this._write(data, body);
    return data;
  }

  append(field, item, { provenance } = {}) {
    if (!ARRAY_FIELDS.has(field)) throw new BriefError(`"${field}" is not a list field.`);
    checkProvenance(field, provenance);
    const { data } = this.read();
    const next = [...(Array.isArray(data[field]) ? data[field] : []), String(item)];
    return this.update(field, next, { provenance });
  }

  missingForGating() {
    const { data } = this.read();
    return GATING_REQUIRED.filter((f) => isEmpty(data[f]));
  }

  isGatingComplete() {
    return Boolean(this.read().data?.gating?.complete);
  }

  completeGating() {
    const missing = this.missingForGating();
    if (missing.length) {
      throw new BriefError(`Gating pass incomplete; still missing: ${missing.join(', ')}.`);
    }
    const { data, body } = this.read();
    data.gating = { ...(data.gating || {}), complete: true, completedAt: new Date().toISOString() };
    this._write(data, body);
    return data;
  }
}

module.exports = { Brief, BriefError, BRIEF_FIELDS, USER_ONLY_FIELDS };
