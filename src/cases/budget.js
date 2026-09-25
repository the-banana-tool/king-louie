// src/cases/budget.js
// Per-case budgets in .kl/budget.json (cases stage 2 spec §3.5, program §4.4).
// The limit of a category is the case override, then the settings default;
// null or 0 means unlimited. The deadline ratio is computed, never stored.
const path = require('path');
const { readJson, writeJsonIfChanged } = require('./jsonfile');
const { localDay, zonedTime, addDays } = require('./clock');

const CATEGORIES = Object.freeze(['usd', 'deadline', 'turnsPerDay', 'contactsPerDay', 'questionsPerDay']);
const PER_DAY = Object.freeze(['turnsPerDay', 'contactsPerDay', 'questionsPerDay']);
const THRESHOLDS = Object.freeze([50, 80, 100]);

const round = (n) => Number(Number(n).toFixed(8));
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class Budget {
  constructor(dir, { defaults = {}, overrides = {}, createdAt = null, now = () => new Date(), timeZone = '' } = {}) {
    this.dir = dir;
    this.path = path.join(dir, '.kl', 'budget.json');
    this.defaults = defaults && typeof defaults === 'object' ? defaults : {};
    this.overrides = overrides && typeof overrides === 'object' ? overrides : {};
    const created = createdAt instanceof Date ? createdAt : (createdAt ? new Date(createdAt) : null);
    this.createdAt = created && Number.isFinite(created.getTime()) ? created : null;
    this.now = now;
    this.timeZone = timeZone || '';
  }

  limitFor(category) {
    const raw = this.overrides[category] ?? this.defaults[category] ?? null;
    if (category === 'deadline') {
      if (raw instanceof Date) return raw.toISOString().slice(0, 10);
      return typeof raw === 'string' && DAY_PATTERN.test(raw) ? raw : null;
    }
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  _load() {
    const data = readJson(this.path, null);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  _entry(data, category) {
    if (!CATEGORIES.includes(category)) {
      throw new Error(`Unknown budget category "${category}". Categories: ${CATEGORIES.join(', ')}.`);
    }
    let e = data[category];
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      e = category === 'deadline'
        ? { at: null, crossed: [], grantedBy: [] }
        : { spent: 0, limit: null, crossed: [], grantedBy: [] };
      if (category === 'usd') e.unpricedTokens = 0;
      if (PER_DAY.includes(category)) e.day = null;
      data[category] = e;
    }
    if (!Array.isArray(e.crossed)) e.crossed = [];
    if (!Array.isArray(e.grantedBy)) e.grantedBy = [];
    if (category === 'deadline') {
      e.at = this.limitFor('deadline');
    } else {
      e.limit = this.limitFor(category);
      if (!Number.isFinite(Number(e.spent))) e.spent = 0;
    }
    if (PER_DAY.includes(category)) {
      const today = localDay(this.now(), this.timeZone);
      // String compare on YYYY-MM-DD: a clock that jumps back never resets.
      if (!e.day || today > e.day) {
        e.day = today;
        e.spent = 0;
        e.crossed = [];
      }
    }
    return e;
  }

  _ratio(category, e) {
    if (category === 'deadline') {
      if (!e.at) return null;
      const end = zonedTime(addDays(e.at, 1), 0, 0, this.timeZone).getTime();
      const now = this.now().getTime();
      if (!this.createdAt) return now >= end ? 1 : 0;
      const start = this.createdAt.getTime();
      if (end <= start) return 1;
      return (now - start) / (end - start);
    }
    if (!e.limit) return null;
    return Number(e.spent) / e.limit;
  }

  // Sets e.crossed to exactly the thresholds the ratio reaches now and
  // returns the ones that were not reached before.
  _settle(category, e) {
    const r = this._ratio(category, e);
    const reached = r === null ? [] : THRESHOLDS.filter((t) => r * 100 >= t - 1e-9);
    const crossedNow = reached.filter((t) => !e.crossed.includes(t));
    e.crossed = reached;
    return crossedNow;
  }

  charge(category, amount = 0, meta = {}) {
    const data = this._load();
    const e = this._entry(data, category);
    if (category !== 'deadline') {
      const add = Number(amount);
      if (Number.isFinite(add) && add !== 0) e.spent = round(Number(e.spent) + add);
      if (category === 'usd') {
        const unpriced = Number(meta?.unpricedTokens);
        if (Number.isFinite(unpriced) && unpriced > 0) e.unpricedTokens = (Number(e.unpricedTokens) || 0) + unpriced;
      }
    }
    const crossedNow = this._settle(category, e);
    writeJsonIfChanged(this.path, data);
    return {
      spent: category === 'deadline' ? null : e.spent,
      limit: category === 'deadline' ? e.at : e.limit,
      crossedNow
    };
  }

  reconcile() {
    const data = this._load();
    const out = {};
    for (const c of CATEGORIES) {
      const crossedNow = this._settle(c, this._entry(data, c));
      if (crossedNow.length) out[c] = crossedNow;
    }
    writeJsonIfChanged(this.path, data);
    return out;
  }

  status() {
    const data = this._load();
    const out = {};
    for (const c of CATEGORIES) {
      const e = this._entry(data, c);
      this._settle(c, e);
      out[c] = { ...e, ratio: this._ratio(c, e) };
    }
    return out;
  }

  remaining(category) {
    const s = this.status()[category];
    if (category === 'deadline' || !s.limit) return null;
    return round(s.limit - s.spent);
  }

  exhausted() {
    const s = this.status();
    return ['usd', 'deadline'].filter((c) => s[c].ratio !== null && s[c].ratio >= 1);
  }

  atLimit(category) {
    const s = this.status()[category];
    return s.ratio !== null && s.ratio >= 1;
  }

  recordGrant(category, factId) {
    const data = this._load();
    const e = this._entry(data, category);
    if (factId && !e.grantedBy.includes(factId)) e.grantedBy.push(factId);
    writeJsonIfChanged(this.path, data);
  }
}

module.exports = { Budget, CATEGORIES, PER_DAY, THRESHOLDS };
