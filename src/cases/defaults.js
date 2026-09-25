// src/cases/defaults.js
// Stage 2 defaults for settings.cases (cases stage 2 spec §6), merged key by
// key so a partial override keeps the other defaults. None of these keys is
// security policy.
const CASE_SETTINGS_DEFAULTS = Object.freeze({
  root: '',
  reorientAfterHours: 8,
  timeZone: '',
  budgets: Object.freeze({ usd: 20, turnsPerDay: 48, contactsPerDay: 20, questionsPerDay: 6, deadline: null }),
  roles: Object.freeze({
    orient: Object.freeze({ tier: 'fast' }),
    classify: Object.freeze({ tier: 'fast' }),
    draft: Object.freeze({ tier: 'standard' }),
    judge: Object.freeze({ tier: 'smart' }),
    verify: Object.freeze({ tier: 'smart' })
  }),
  wakeups: Object.freeze({
    enabled: true,
    dailyAt: '09:00',
    maxIterations: 20,
    maxCasesPerTick: 3,
    retryBackoffMinutes: Object.freeze([5, 15, 60])
  })
});

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// Plain, unfrozen copies: settings objects are edited by the settings UI.
const fresh = () => JSON.parse(JSON.stringify(CASE_SETTINGS_DEFAULTS));

function mergeCaseSettings(base = {}, source = {}) {
  const d = fresh();
  const b = obj(base);
  const s = obj(source);
  return {
    ...d,
    ...b,
    ...s,
    budgets: { ...d.budgets, ...obj(b.budgets), ...obj(s.budgets) },
    roles: { ...d.roles, ...obj(b.roles), ...obj(s.roles) },
    wakeups: { ...d.wakeups, ...obj(b.wakeups), ...obj(s.wakeups) }
  };
}

const positive = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const positiveInt = (v, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

// The merged settings with every value the runtime relies on made valid.
function resolveCaseSettings(source = {}) {
  const m = mergeCaseSettings({}, source);
  const d = CASE_SETTINGS_DEFAULTS;
  return {
    ...m,
    reorientAfterHours: positive(m.reorientAfterHours, d.reorientAfterHours),
    timeZone: typeof m.timeZone === 'string' ? m.timeZone : '',
    wakeups: {
      ...m.wakeups,
      enabled: m.wakeups.enabled !== false,
      dailyAt: typeof m.wakeups.dailyAt === 'string' ? m.wakeups.dailyAt : d.wakeups.dailyAt,
      maxIterations: positiveInt(m.wakeups.maxIterations, d.wakeups.maxIterations),
      maxCasesPerTick: positiveInt(m.wakeups.maxCasesPerTick, d.wakeups.maxCasesPerTick),
      retryBackoffMinutes: Array.isArray(m.wakeups.retryBackoffMinutes) ? m.wakeups.retryBackoffMinutes : [...d.wakeups.retryBackoffMinutes]
    }
  };
}

module.exports = { CASE_SETTINGS_DEFAULTS, mergeCaseSettings, resolveCaseSettings };
