// src/cases/case-store.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const git = require('./git');
const { uniqueSlug } = require('./slug');
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
    gating: { complete: false }
  }).trimEnd(),
  '---',
  '',
  ''
].join('\n');

const newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

class CaseStore {
  constructor({ root }) {
    if (!root) throw new Error('CaseStore requires a root directory');
    // Nothing is created until the first case is, so constructing a store at
    // startup never touches the data dir.
    this.root = root;
  }

  async create({ title, type = 'general', objective = '' } = {}) {
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
      fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump(meta));
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
      const meta = yaml.load(fs.readFileSync(path.join(dir, 'case.yaml'), 'utf8'));
      if (!meta || typeof meta !== 'object' || !meta.id) return null;
      return { playbooks: [], related: [], ...meta, dir };
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
    fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump(meta));
    return { ...meta, dir };
  }
}

module.exports = { CaseStore, STATUSES };
