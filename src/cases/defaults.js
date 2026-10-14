// src/cases/defaults.js
// Stage 2 defaults for settings.cases (cases stage 2 spec §6), merged key by
// key so a partial override keeps the other defaults. One key here is
// security policy: softwareRepo.check.enabled decides whether a case may
// start a program (cases stage 8, R-C8-3). It is off by default, and in
// service mode it is read only from the admin service.json ("caseChecks";
// src/cases/verify/check.js), never from here.
const CASE_SETTINGS_DEFAULTS = Object.freeze({
  root: '',
  reorientAfterHours: 8,
  timeZone: '',
  budgets: Object.freeze({ usd: 20, turnsPerDay: 48, contactsPerDay: 20, questionsPerDay: 6, deadline: null }),
  // Case roles on model roles (models spec 2026-09-27 §8); tier names in a
  // stored setting still read as the mapped role (src/cases/roles.js).
  roles: Object.freeze({
    orient: Object.freeze({ role: 'utility' }),
    classify: Object.freeze({ role: 'utility' }),
    draft: Object.freeze({ role: 'worker' }),
    judge: Object.freeze({ role: 'main' }),
    verify: Object.freeze({ role: 'main' })
  }),
  wakeups: Object.freeze({
    enabled: true,
    dailyAt: '09:00',
    maxIterations: 20,
    maxCasesPerTick: 3,
    retryBackoffMinutes: Object.freeze([5, 15, 60])
  }),
  // Cases stage 5 (docs/superpowers/specs/2026-09-23-cases-stage5-detours.md §6).
  detours: Object.freeze({
    classifyOwnerMessages: true,
    minConfidence: 0.7,
    classifyTimeoutMs: 4000,
    recentDays: 30,
    maxCandidates: 2
  }),
  duplicates: Object.freeze({ createSimilarity: 0.6 }),
  // `check` (cases stage 8 spec §6.6, §9): the check command. `envAllow`
  // names environment variables the command is given beside the fixed few.
  softwareRepo: Object.freeze({
    refreshBudgetMs: 6000,
    check: Object.freeze({ enabled: false, timeoutMs: 120000, envAllow: Object.freeze([]) })
  }),
  // Cases stage 8 (spec §6.5, §9; R-C8-4): the verify pass at the close of
  // a turn that changed the record. `when`: 'changed-turn', 'request' (only
  // when asked for) or 'off'.
  verify: Object.freeze({ when: 'changed-turn', timeoutMs: 20000, maxInputChars: 12000, maxPassesPerDay: 24, skipAboveUsdPercent: 80 })
});

const VERIFY_WHEN = Object.freeze(['changed-turn', 'request', 'off']);
const CHECK_TIMEOUT_MAX_MS = 900000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Never handed to a check, whatever envAllow says: King Louie's own
// variables, and the one that makes an Electron binary run as plain Node.
const envNameRefused = (name) => /^(KL_|KING_LOUIE_)/i.test(name) || name.toUpperCase() === 'ELECTRON_RUN_AS_NODE';

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
    // Cases stage 7: document ingest limits (src/cases/ingest/settings.js).
    ingest: require('./ingest/settings').mergeIngestSettings(b.ingest, s.ingest),
    roles: { ...d.roles, ...obj(b.roles), ...obj(s.roles) },
    wakeups: { ...d.wakeups, ...obj(b.wakeups), ...obj(s.wakeups) },
    detours: { ...d.detours, ...obj(b.detours), ...obj(s.detours) },
    duplicates: { ...d.duplicates, ...obj(b.duplicates), ...obj(s.duplicates) },
    softwareRepo: {
      ...d.softwareRepo,
      ...obj(b.softwareRepo),
      ...obj(s.softwareRepo),
      check: { ...d.softwareRepo.check, ...obj(obj(b.softwareRepo).check), ...obj(obj(s.softwareRepo).check) }
    },
    verify: { ...d.verify, ...obj(b.verify), ...obj(s.verify) }
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
const percent = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
};
const fraction = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
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
    },
    detours: {
      ...m.detours,
      classifyOwnerMessages: typeof m.detours.classifyOwnerMessages === 'boolean' ? m.detours.classifyOwnerMessages : d.detours.classifyOwnerMessages,
      minConfidence: fraction(m.detours.minConfidence, d.detours.minConfidence),
      classifyTimeoutMs: positiveInt(m.detours.classifyTimeoutMs, d.detours.classifyTimeoutMs),
      recentDays: positive(m.detours.recentDays, d.detours.recentDays),
      maxCandidates: positiveInt(m.detours.maxCandidates, d.detours.maxCandidates)
    },
    duplicates: { ...m.duplicates, createSimilarity: fraction(m.duplicates.createSimilarity, d.duplicates.createSimilarity) },
    softwareRepo: {
      ...m.softwareRepo,
      refreshBudgetMs: positiveInt(m.softwareRepo.refreshBudgetMs, d.softwareRepo.refreshBudgetMs),
      check: {
        // On only when it is exactly true.
        enabled: m.softwareRepo.check.enabled === true,
        timeoutMs: Math.min(positiveInt(m.softwareRepo.check.timeoutMs, d.softwareRepo.check.timeoutMs), CHECK_TIMEOUT_MAX_MS),
        envAllow: (Array.isArray(m.softwareRepo.check.envAllow) ? m.softwareRepo.check.envAllow : [])
          .filter((name) => typeof name === 'string' && ENV_NAME.test(name) && !envNameRefused(name))
      }
    },
    verify: {
      ...m.verify,
      when: VERIFY_WHEN.includes(m.verify.when) ? m.verify.when : d.verify.when,
      timeoutMs: positiveInt(m.verify.timeoutMs, d.verify.timeoutMs),
      maxInputChars: positiveInt(m.verify.maxInputChars, d.verify.maxInputChars),
      maxPassesPerDay: positiveInt(m.verify.maxPassesPerDay, d.verify.maxPassesPerDay),
      skipAboveUsdPercent: percent(m.verify.skipAboveUsdPercent, d.verify.skipAboveUsdPercent)
    }
  };
}

module.exports = { CASE_SETTINGS_DEFAULTS, mergeCaseSettings, resolveCaseSettings };
