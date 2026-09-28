// src/models/king-louie.js
// The King Louie profile (spec 2026-09-27 §7): proposes models for each
// role from the usable models, their prices and their scores
// (./suggester.js); nothing changes until the owner accepts, or
// models.kingLouie.autoAccept is on. A dismissed proposal stays hidden until
// the proposed models change. The profile itself (kind 'king-louie') is
// created by the first accept.
const EventEmitter = require('events');
const { createLogger } = require('../logging');
const { ProfileError } = require('./profiles');
const S = require('./suggester');

const log = createLogger('models/king-louie');
const KING_LOUIE_NAME = 'King Louie selected';

class KingLouieProfile extends EventEmitter {
  constructor({
    profiles, availability, catalog = null, getSettings, setSettings, getRecentUsage = () => ({}), debounceMs = 200,
    // Gates auto-accept only (fix round 1 #6): the host can compute and show
    // proposals from the first provider status change, but hold off taking
    // one on its own until it says the initial round of startup checks has
    // settled, so auto-accept never churns through intermediate picks made
    // from a partial set of tested providers. Always ready by default: only
    // a host that wires a startup sequence (the core) needs to gate this.
    readyForAutoAccept = () => true
  } = {}) {
    super();
    for (const [name, value] of Object.entries({ profiles, availability, getSettings, setSettings })) {
      if (!value) throw new Error(`KingLouieProfile needs ${name}.`);
    }
    this.profiles = profiles;
    this.availability = availability;
    this.catalog = catalog;
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.getRecentUsage = getRecentUsage;
    this.debounceMs = debounceMs;
    this.readyForAutoAccept = readyForAutoAccept;
    this._timer = null;
  }

  settings() {
    return S.mergeKingLouieSettings((this.getSettings() || {}).models?.kingLouie);
  }

  profile() {
    return this.profiles.list().find((p) => p.kind === 'king-louie') || null;
  }

  _nameOf(target) {
    const entry = this.catalog ? this.catalog.get(target.provider, target.model) : null;
    return entry?.name || target.model;
  }

  candidates() {
    const usable = typeof this.availability.usable === 'function' ? this.availability.usable({ needs: {} }) : [];
    return usable.map((c) => S.candidateFromEntry(c, this.catalog ? this.catalog.get(c.provider, c.model) : null));
  }

  propose() {
    const settings = this.settings();
    const picks = S.pickRoles(this.candidates(), settings);
    if (picks.unavailable) return { unavailable: picks.unavailable };
    let usage = {};
    try {
      usage = this.getRecentUsage() || {};
    } catch (err) {
      log.warn(`Reading recent usage for the King Louie proposal failed: ${err.message}`);
    }
    const current = this.profile();
    const proposal = S.buildProposal({
      picks,
      current: current ? current.roles : null,
      usage,
      price: (t, u) => {
        const priced = this.catalog ? this.catalog.price(t.provider, t.model, u) : null;
        return priced ? priced.usd : null;
      },
      nameOf: (t) => this._nameOf(t)
    });
    return { ...proposal, dismissed: Boolean(proposal.id) && proposal.id === settings.dismissedProposalId };
  }

  view() {
    const settings = this.settings();
    const current = this.profile();
    const named = (t) => ({ provider: t.provider, model: t.model, effort: t.effort || null, name: this._nameOf(t) });
    const out = {
      profile: current ? { id: current.id, name: current.name } : null,
      current: current ? Object.fromEntries(Object.entries(current.roles).map(([role, list]) => [role, list.map(named)])) : null,
      proposal: null,
      upToDate: false,
      unavailable: null,
      settings: {
        autoAccept: settings.autoAccept,
        bandPoints: settings.bandPoints,
        workerAgenticRatio: settings.workerAgenticRatio,
        utilityIntelligenceRatio: settings.utilityIntelligenceRatio,
        preferLocalUtility: settings.preferLocalUtility
      }
    };
    const p = this.propose();
    if (p.unavailable) out.unavailable = p.unavailable;
    else if (p.upToDate) out.upToDate = true;
    else out.proposal = { id: p.id, changes: p.changes, costEffect: p.costEffect, dismissed: p.dismissed };
    return out;
  }

  // The owner accepts the proposal they saw: refused when it has changed
  // since, so a different set of models is never applied.
  accept(proposalId) {
    const now = this.propose();
    if (now.unavailable) throw new ProfileError('NO_PROPOSAL', now.unavailable);
    if (!now.id) throw new ProfileError('NO_PROPOSAL', 'The King Louie profile is up to date; there is nothing to accept.');
    if (now.id !== proposalId) throw new ProfileError('STALE_PROPOSAL', 'The proposal changed since it was shown. Review the new one, then accept it.');
    const current = this.profile();
    const saved = current
      ? this.profiles.update(current.id, { roles: now.roles })
      : this.profiles.create({ name: this._freeName(KING_LOUIE_NAME), kind: 'king-louie', roles: now.roles });
    if (this.settings().dismissedProposalId) this._writeSettings({ dismissedProposalId: null });
    log.info(`Accepted King Louie proposal ${now.id}.`);
    this._emit();
    return saved;
  }

  dismiss(proposalId) {
    const now = this.propose();
    if (now.unavailable || !now.id) throw new ProfileError('NO_PROPOSAL', now.unavailable || 'There is no proposal to dismiss.');
    if (now.id !== proposalId) throw new ProfileError('STALE_PROPOSAL', 'The proposal changed since it was shown. Review the new one.');
    this._writeSettings({ dismissedProposalId: now.id });
    this._emit();
    return { dismissed: now.id };
  }

  saveSettings(patch = {}) {
    const next = {};
    if (patch.autoAccept !== undefined) next.autoAccept = patch.autoAccept === true;
    if (patch.preferLocalUtility !== undefined) next.preferLocalUtility = patch.preferLocalUtility === true;
    const ranged = (key, min, max, label) => {
      const raw = patch[key];
      if (raw === undefined) return;
      // Number(...) turns null, "", " ", false and [] into 0, which would
      // silently pass as a valid setting; accept only an actual finite
      // number or a non-empty numeric string (fix round 1 #1).
      const n = typeof raw === 'number'
        ? raw
        : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
      if (!Number.isFinite(n) || n < min || n > max) throw new ProfileError('BAD_SETTING', `${label} is a number from ${min} to ${max}.`);
      next[key] = n;
    };
    ranged('bandPoints', 0, 50, 'The band');
    ranged('workerAgenticRatio', 0, 1, 'The worker ratio');
    ranged('utilityIntelligenceRatio', 0, 1, 'The utility ratio');
    this._writeSettings(next);
    this.refresh();
    return this.settings();
  }

  // "Duplicate as my profile" (spec §7.2): the accepted picks, or the
  // pending proposal's before anything was accepted, as an ordinary
  // profile. Before an Accept, an optional proposalId is checked the same
  // way Accept checks it, so duplicating a stale view is refused rather
  // than silently copying whatever the picks have since become (fix round
  // 1 #2).
  duplicateAsProfile({ name, proposalId } = {}) {
    let roles = this.profile()?.roles || null;
    if (!roles) {
      const p = this.propose();
      if (p.unavailable) throw new ProfileError('NO_PROPOSAL', p.unavailable);
      if (proposalId !== undefined && p.id !== proposalId) {
        throw new ProfileError('STALE_PROPOSAL', 'The proposal changed since it was shown. Review the new one, then duplicate it.');
      }
      roles = p.roles;
    }
    const base = String(name || `${KING_LOUIE_NAME} copy`).trim();
    return this.profiles.create({ name: this._freeName(base), kind: 'user', roles });
  }

  // Recompute now: accept a new proposal when autoAccept is on (never a
  // dismissed one), then tell listeners. accept() already emits, so a
  // successful auto-accept does not emit again here (fix round 1 #4).
  refresh() {
    let accepted = false;
    try {
      if (this.settings().autoAccept && this.readyForAutoAccept()) {
        const p = this.propose();
        if (p.id && !p.dismissed) {
          this.accept(p.id);
          accepted = true;
        }
      }
    } catch (err) {
      log.warn(`Refreshing the King Louie proposal failed: ${err.message}`);
    }
    if (!accepted) this._emit();
  }

  // An input changed (a catalog refresh, a key test): recompute once the
  // burst settles.
  inputsChanged() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.refresh();
    }, this.debounceMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _freeName(base) {
    const taken = new Set(this.profiles.list().map((p) => p.name.toLowerCase()));
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${base} ${n}`;
    return candidate;
  }

  _writeSettings(patch) {
    const settings = this.getSettings() || {};
    const models = settings.models || {};
    this.setSettings({ ...settings, models: { ...models, kingLouie: { ...(models.kingLouie || {}), ...patch } } });
  }

  _emit() {
    if (!this.listenerCount('proposal')) return;
    try {
      this.emit('proposal', this.view());
    } catch (err) {
      log.warn(`Building the King Louie view failed: ${err.message}`);
    }
  }
}

module.exports = { KingLouieProfile, KING_LOUIE_NAME };
