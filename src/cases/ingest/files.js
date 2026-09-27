// src/cases/ingest/files.js
// The files ingest keeps under a case's .kl/ingest/ (cases stage 7 spec
// §4.2, §4.3): the committed record and text store, and the gitignored page
// cache and pending publish. Writes are atomic (temp file + rename, through
// src/cases/jsonfile.js, ruling M17).
//
// Every path builder checks the docId (`doc-` + 12 hex) and the page number
// before a file is touched (ruling M8): a docId from a caller, a record or
// a directory listing never walks out of .kl/ingest/. What is read back is
// untrusted too (the model's Bash and imports can write these files): reads
// are size-capped, and a record or text store whose docId is not the one
// asked for is treated as missing.
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeAtomic } = require('../jsonfile');
const { DOC_ID, checkDocId, recordPath } = require('./store');
const { PROPOSAL_ID } = require('./review');
const { IngestError } = require('./errors');
const { createLogger } = require('../../logging');

const log = createLogger('cases/ingest/files');

const RECORD_FILE = /^doc-[0-9a-f]{12}\.json$/;
const CACHE_IGNORE = '.kl/ingest/cache/';
const MAX_PAGE = 100000;
// Records and text stores are bounded by the ingest limits (maxProposalsPerDoc,
// maxPages, the capped model replies); anything far larger was not written by
// the host.
const MAX_READ_BYTES = 64 * 1024 * 1024;

function checkPage(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PAGE) {
    throw new IngestError('BAD_PAGE', `A page number is a whole number from 1 to ${MAX_PAGE}.`);
  }
  return n;
}

const ingestDir = (caseDir) => path.join(caseDir, '.kl', 'ingest');
const recordFile = (caseDir, docId) => recordPath(caseDir, docId);
const textFile = (caseDir, docId) => path.join(ingestDir(caseDir), `${checkDocId(docId)}.text.json`);
const cacheDir = (caseDir, docId) => path.join(ingestDir(caseDir), 'cache', checkDocId(docId));
const pageFile = (caseDir, docId, n) => path.join(cacheDir(caseDir, docId), `${checkPage(n)}.json`);
const publishFile = (caseDir, docId) => path.join(cacheDir(caseDir, docId), 'publish.json');

// null when missing, unreadable, oversized or not JSON; never throws.
function readCapped(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size > MAX_READ_BYTES) {
      log.warn(`${file} is ${st.size} bytes, over the ${MAX_READ_BYTES}-byte cap; ignored.`);
      return null;
    }
    return readJson(file, null);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`Reading ${file} failed: ${err.message}`);
    return null;
  }
}

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const ownDoc = (value, docId) => (isObj(value) && value.docId === docId ? value : null);

function readRecord(caseDir, docId) {
  return ownDoc(readCapped(recordFile(caseDir, docId)), docId);
}

function writeRecord(caseDir, record) {
  writeJson(recordFile(caseDir, record?.docId), record);
}

function readTextStore(caseDir, docId) {
  return ownDoc(readCapped(textFile(caseDir, docId)), docId);
}

function writeTextStore(caseDir, store) {
  writeJson(textFile(caseDir, store?.docId), store);
}

// Every well-formed record, by docId; a file whose content names another
// docId is skipped.
function listRecords(caseDir) {
  let names = [];
  try {
    names = fs.readdirSync(ingestDir(caseDir)).filter((n) => RECORD_FILE.test(n));
  } catch {
    return [];
  }
  return names.sort().map((n) => readRecord(caseDir, n.slice(0, -'.json'.length))).filter(Boolean);
}

function readCachedPage(caseDir, docId, n) {
  return readCapped(pageFile(caseDir, docId, n));
}

function writeCachedPage(caseDir, docId, entry) {
  writeJson(pageFile(caseDir, docId, entry?.n), entry);
}

function readPendingPublish(caseDir, docId) {
  return readCapped(publishFile(caseDir, docId));
}

function writePendingPublish(caseDir, docId, payload) {
  writeJson(publishFile(caseDir, docId), payload);
}

function clearPendingPublish(caseDir, docId) {
  fs.rmSync(publishFile(caseDir, docId), { force: true });
}

// docIds with a publish waiting; directory names that are not docIds are
// ignored.
function pendingPublishes(caseDir) {
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(ingestDir(caseDir), 'cache'));
  } catch {
    return [];
  }
  return ids.filter((id) => DOC_ID.test(id) && fs.existsSync(publishFile(caseDir, id))).sort();
}

// The page cache is local working state; the case .gitignore keeps it out
// of history. Cases created before stage 7 gain the line on first ingest.
function ensureCacheIgnored(caseDir) {
  const file = path.join(caseDir, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (text.split(/\r?\n/).includes(CACHE_IGNORE)) return false;
  writeAtomic(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${CACHE_IGNORE}\n`);
  return true;
}

// Newest mtime, total size and count of the files under .kl/ingest/ except
// the cache: the entity index re-reads a case when any of them changes.
function ingestStat(caseDir) {
  let latest = 0;
  let bytes = 0;
  let count = 0;
  let names = [];
  try {
    names = fs.readdirSync(ingestDir(caseDir));
  } catch {
    return { mtime: null, mtimeMs: 0, bytes: 0, count: 0 };
  }
  for (const n of names) {
    if (n === 'cache') continue;
    try {
      const st = fs.statSync(path.join(ingestDir(caseDir), n));
      latest = Math.max(latest, st.mtimeMs);
      bytes += st.size;
      count += 1;
    } catch { /* removed meanwhile */ }
  }
  return { mtime: latest ? new Date(latest).toISOString() : null, mtimeMs: latest, bytes, count };
}

const ingestMtime = (caseDir) => ingestStat(caseDir).mtime;

module.exports = {
  CACHE_IGNORE,
  PROPOSAL_ID,
  MAX_READ_BYTES,
  ingestDir,
  readRecord,
  writeRecord,
  readTextStore,
  writeTextStore,
  listRecords,
  readCachedPage,
  writeCachedPage,
  readPendingPublish,
  writePendingPublish,
  clearPendingPublish,
  pendingPublishes,
  ensureCacheIgnored,
  ingestStat,
  ingestMtime
};
