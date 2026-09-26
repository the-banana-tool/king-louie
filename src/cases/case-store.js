// src/cases/case-store.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { parseYaml } = require('../platform/yaml');
const git = require('./git');
const { uniqueSlug } = require('./slug');
const { assertKnownType } = require('./case-types');
const { createLogger } = require('../logging');

const log = createLogger('cases');

const STATUSES = new Set(['draft', 'active', 'needs-direction', 'paused', 'done', 'abandoned']);

const GITIGNORE = ['.kl/index/', '.kl/runs/', '.kl/lock', ''].join('\n');

const BRIEF_TEMPLATE = (objective) => [
  '---',
  yaml.dump({
    objective: objective || '',
    why: '',
    successCriteria: [],
    hardConstraints: [],
    alreadyTried: [],
    resources: { executors: [], ownerLabor: [] },
    deadline: null,
    materiality: { tell: [], ignore: [] },
    safeDefaults: [],
    gating: { complete: false }
  }, { noRefs: true }).trimEnd(),
  '---',
  '',
  ''
].join('\n');

// Every key a stage writes to case.yaml, with the stage that owns it
// (cases stage 6 plan, Task 1). The strict parser accepts any key; this
// table documents them and tests/cases-store-yaml.test.js round-trips each.
const CASE_YAML_KEYS = Object.freeze({
  id: 'C1',
  slug: 'C1',
  title: 'C1',
  type: 'C1',
  status: 'C1',
  created: 'C1',
  playbooks: 'C6',
  related: 'C5',
  lastTurnAt: 'C2',
  lastOwnerTurnAt: 'C2',
  statusReason: 'C2',
  budget: 'C2',
  roles: 'C2',
  autonomy: 'C2',
  channels: 'C4'
});

// case.yaml through the strict parser (program §4.11): core schema only, so
// timestamps and dates stay strings, and duplicate keys or custom tags throw.
// Returns null for a document that is not a mapping or names no id.
function parseCaseYaml(text) {
  const meta = parseYaml(String(text).replace(/^﻿/, ''));
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !meta.id) return null;
  return meta;
}

const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

class CaseStore {
  constructor({ root }) {
    if (!root) throw new Error('CaseStore requires a root directory');
    // Nothing is created until the first case is, so constructing a store at
    // startup never touches the data dir.
    this.root = root;
  }

  async create({ title, type = 'general', objective = '' } = {}) {
    assertKnownType(type);
    if (!(await git.isGitAvailable())) throw new git.GitUnavailableError();
    fs.mkdirSync(this.root, { recursive: true });
    const slug = uniqueSlug(this.root, title);
    const dir = path.join(this.root, slug);
    const meta = {
      id: newId(),
      slug,
      title: String(title || slug),
      type,
      status: 'draft',
      created: new Date().toISOString(),
      playbooks: [],
      related: []
    };
    fs.mkdirSync(dir);
    try {
      for (const d of ['journal', 'sources', 'artifacts', 'playbooks', '.kl']) {
        fs.mkdirSync(path.join(dir, d));
        fs.writeFileSync(path.join(dir, d, '.gitkeep'), '');
      }
      fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump(meta, { noRefs: true }));
      fs.writeFileSync(path.join(dir, 'brief.md'), BRIEF_TEMPLATE(objective));
      fs.writeFileSync(path.join(dir, 'facts.jsonl'), '');
      fs.writeFileSync(path.join(dir, 'decisions.md'), '# Decisions\n');
      fs.writeFileSync(path.join(dir, 'open-items.md'), '# Open items\n');
      fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
      await git.initRepo(dir);
      await git.commitAll(dir, `case created: ${meta.title}`);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    return { ...meta, dir };
  }

  _read(dir) {
    try {
      const meta = parseCaseYaml(fs.readFileSync(path.join(dir, 'case.yaml'), 'utf8'));
      if (!meta) return null;
      return {
        ...meta,
        playbooks: Array.isArray(meta.playbooks) ? meta.playbooks : [],
        related: Array.isArray(meta.related) ? meta.related : [],
        dir
      };
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Unreadable case.yaml in ${dir}: ${err.message}`);
      return null;
    }
  }

  list() {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => this._read(path.join(this.root, e.name)))
      .filter(Boolean)
      .sort((a, b) => String(a.created).localeCompare(String(b.created)));
  }

  get(idOrSlug) {
    return this.list().find((c) => c.id === idOrSlug || c.slug === idOrSlug) || null;
  }

  updateMeta(idOrSlug, patch = {}) {
    const current = this.get(idOrSlug);
    if (!current) throw new Error(`Case not found: ${idOrSlug}`);
    if (patch.status !== undefined && !STATUSES.has(patch.status)) {
      throw new Error(`Invalid case status: ${patch.status}`);
    }
    const { dir, ...meta } = { ...current, ...patch, id: current.id, slug: current.slug };
    fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump(meta, { noRefs: true }));
    return { ...meta, dir };
  }
}

module.exports = { CaseStore, STATUSES, CASE_YAML_KEYS, parseCaseYaml };
