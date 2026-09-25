// src/cases/brief.js
// brief.md: YAML front matter (structured fields) + free prose (spec §4.3).
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const BRIEF_FIELDS = new Set([
  'objective', 'why', 'successCriteria', 'hardConstraints', 'alreadyTried',
  'resources', 'deadline', 'materiality', 'safeDefaults'
]);
// Stage 2: materiality, deadline and safeDefaults feed gates (briefing
// urgency, the deadline budget, acting on silence), so only the owner sets them.
const USER_ONLY_FIELDS = new Set(['why', 'hardConstraints', 'alreadyTried', 'materiality', 'deadline', 'safeDefaults']);
const ARRAY_FIELDS = new Set(['successCriteria', 'hardConstraints', 'alreadyTried', 'safeDefaults']);
const OBJECT_FIELDS = new Set(['resources', 'materiality']);
const GATING_REQUIRED = ['objective', 'why', 'successCriteria'];

class BriefError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BriefError';
  }
}

function validate(field, value, extraNames = []) {
  if (!BRIEF_FIELDS.has(field)) {
    throw new BriefError(`Unknown brief field "${field}". Fields: ${[...BRIEF_FIELDS, ...extraNames].join(', ')}.`);
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

const isEmpty = (v) => v === undefined || v === null
  || (typeof v === 'string' && !v.trim())
  || (Array.isArray(v) && v.length === 0);

class Brief {
  // extraFields: the case type's brief fields ([{ name, kind: 'text',
  // userOnly, validate? }]); gatingFields: the fields of required
  // field-backed gating questions (cases stage 5 spec §3.7).
  constructor(dir, { extraFields = [], gatingFields = [] } = {}) {
    this.dir = dir;
    this.path = path.join(dir, 'brief.md');
    this.extra = new Map((Array.isArray(extraFields) ? extraFields : [])
      .filter((f) => f && typeof f.name === 'string')
      .map((f) => [f.name, f]));
    this.gatingFields = (Array.isArray(gatingFields) ? gatingFields : []).filter((f) => typeof f === 'string');
  }

  isUserOnly(field) {
    return USER_ONLY_FIELDS.has(field) || Boolean(this.extra.get(field)?.userOnly);
  }

  _validate(field, value) {
    const extra = this.extra.get(field);
    if (!extra) {
      validate(field, value, [...this.extra.keys()]);
      return;
    }
    if (typeof value !== 'string') throw new BriefError(`"${field}" must be a string.`);
    if (typeof extra.validate === 'function') {
      try {
        extra.validate(value);
      } catch (err) {
        throw new BriefError(err.message);
      }
    }
  }

  _checkProvenance(field, provenance) {
    if (this.isUserOnly(field) && provenance !== 'user') {
      throw new BriefError(`"${field}" can only be set from something the owner said (provenance "user"). Ask the owner instead of filling it in.`);
    }
  }

  read() {
    // Some editors save a UTF-8 byte-order mark; it would hide the opening '---'.
    const text = fs.readFileSync(this.path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
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
    this._validate(field, value);
    this._checkProvenance(field, provenance);
    const { data, body } = this.read();
    data[field] = value;
    this._write(data, body);
    return data;
  }

  append(field, item, { provenance } = {}) {
    if (!ARRAY_FIELDS.has(field)) throw new BriefError(`"${field}" is not a list field.`);
    this._checkProvenance(field, provenance);
    const { data } = this.read();
    const next = [...(Array.isArray(data[field]) ? data[field] : []), String(item)];
    return this.update(field, next, { provenance });
  }

  missingForGating() {
    const { data } = this.read();
    const required = [...GATING_REQUIRED, ...this.gatingFields.filter((f) => !GATING_REQUIRED.includes(f))];
    return required.filter((f) => isEmpty(data[f]));
  }

  // The named writer for the prose under the front matter.
  writeBody(text) {
    const { data } = this.read();
    this._write(data, `${String(text ?? '').trimEnd()}\n`);
    return data;
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
