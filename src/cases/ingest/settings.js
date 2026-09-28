// src/cases/ingest/settings.js
// settings.cases.ingest (cases stage 7 spec §6): resource limits, not
// security policy. mergeIngestSettings keeps every default a partial
// override leaves out; resolveIngestSettings also repairs invalid values.
const INGEST_DEFAULTS = Object.freeze({
  maxBytes: 52428800,
  maxPages: 500,
  maxVisionPagesPerDoc: 20,
  ocrUsdPerPageEstimate: 0.02,
  textQualityThreshold: 0.6,
  chunkChars: 12000,
  maxExtractChars: 400000,
  maxProposalsPerDoc: 200,
  entities: Object.freeze({ spanNames: false })
});

// A null-prototype shallow copy of v's own enumerable string keys, dropping
// "__proto__" itself. Untrusted settings (parsed JSON) can carry a genuine
// own property literally named "__proto__" (JSON.parse never triggers the
// accessor); copying it forward with a for-in/Object.assign onto an ordinary
// object could otherwise repoison the prototype chain downstream. Building
// through a null-prototype object and skipping that key keeps it inert no
// matter how the copy is later merged (hardening checklist #4).
function obj(v) {
  const out = Object.create(null);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const key of Object.keys(v)) {
    if (key === '__proto__') continue;
    out[key] = v[key];
  }
  return out;
}

function mergeIngestSettings(base = {}, source = {}) {
  const d = JSON.parse(JSON.stringify(INGEST_DEFAULTS));
  const b = obj(base);
  const s = obj(source);
  // cases.ingest.vision moved to the profile's vision role (models spec
  // 2026-09-27 §13 step 6): a stored copy is dropped, never read.
  const { vision: _baseVision, ...baseRest } = b;
  const { vision: _sourceVision, ...sourceRest } = s;
  return {
    ...d,
    ...baseRest,
    ...sourceRest,
    entities: { ...d.entities, ...obj(b.entities), ...obj(s.entities) }
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
const fraction = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
};
function resolveIngestSettings(source = {}) {
  const m = mergeIngestSettings({}, source);
  const d = INGEST_DEFAULTS;
  return {
    maxBytes: positiveInt(m.maxBytes, d.maxBytes),
    maxPages: positiveInt(m.maxPages, d.maxPages),
    maxVisionPagesPerDoc: positiveInt(m.maxVisionPagesPerDoc, d.maxVisionPagesPerDoc),
    ocrUsdPerPageEstimate: positive(m.ocrUsdPerPageEstimate, d.ocrUsdPerPageEstimate),
    textQualityThreshold: fraction(m.textQualityThreshold, d.textQualityThreshold),
    chunkChars: positiveInt(m.chunkChars, d.chunkChars),
    maxExtractChars: positiveInt(m.maxExtractChars, d.maxExtractChars),
    maxProposalsPerDoc: positiveInt(m.maxProposalsPerDoc, d.maxProposalsPerDoc),
    entities: { spanNames: m.entities.spanNames === true }
  };
}

module.exports = { INGEST_DEFAULTS, mergeIngestSettings, resolveIngestSettings };
