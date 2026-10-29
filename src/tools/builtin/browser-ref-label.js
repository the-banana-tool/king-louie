'use strict';

// What the owner approves when a call names a ref (spec 2026-10-28 browser
// runner, C-8, §7.5). A ref ("ref=e15") means nothing on an approval card, so
// before anyone is asked ToolExecutor calls the browser tools'
// `prepareParams`, which puts what the ref names on the call: `ref_label` for
// `selector`, `target_ref_label` for drag_and_drop's `target_selector` (the
// role and accessible name from the page's last snapshot, one plain line or
// hidden, at most 80 characters). A model's own labels are always dropped
// first. At run time the handler compares the element's role and name now
// with what was approved, and refuses `ref_changed` on a difference.
//
// Only `selector` and `target_selector` take a ref (C-7). A ref, or a raw
// aria-ref=, in any other selector field (login's usernameSelector, a payment
// helper's cardNumberSelector, ...) is refused invalid_params: it would act on
// an element with no label shown and no run-time check.

const { ACTING_ACTIONS } = require('../browser-acting');
const { plainLineProblem } = require('../../cases/hidden-chars');
const { getBrowser } = require('./browser-registry');
const {
  BrowserRefError, parseRefSelector, isFrameAction, RAW_ARIA_REF,
} = require('../../browser/playwright-browser');

const LABEL_MAX = 80;
const LABEL_FIELDS = [['selector', 'ref_label'], ['target_selector', 'target_ref_label']];
const REF_FIELDS = new Set(LABEL_FIELDS.map(([sel]) => sel));

// The labels as the snapshot gave them, before hiding or cutting, so the
// run-time comparison is exact (two names hidden alike, or alike in their
// first 80 characters, are still told apart). Keyed by what survives any copy
// of the params, the ref and the label shown, not by the params object: a
// caller that spreads or clones the params between the approval and the run
// still compares exactly. Every raw label seen behind one shown label is kept
// (the owner could not tell them apart). Bounded; the oldest goes first.
const RAW_MAX = 512;
const approvedRaw = new Map();

function rememberRaw(ref, shown, raw) {
  const key = JSON.stringify([ref, shown]);
  const set = approvedRaw.get(key) || new Set();
  set.add(raw);
  approvedRaw.delete(key);
  approvedRaw.set(key, set);
  while (approvedRaw.size > RAW_MAX) approvedRaw.delete(approvedRaw.keys().next().value);
}

function rawFor(ref, shown) {
  return approvedRaw.get(JSON.stringify([ref, shown])) || null;
}

/** A snapshot label ('role "name"') as the approval shows it. */
function shownRefLabel(raw) {
  const text = String(raw);
  let label = text;
  if (plainLineProblem(text) !== null) {
    const role = text.match(/^[a-z][a-zA-Z]*/);
    label = `${role ? `${role[0]} ` : ''}(name hidden: not one plain line)`;
  }
  const chars = Array.from(label);
  return chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX - 1).join('')}…` : label;
}

/**
 * A ref (or a raw aria-ref=) in a selector field other than `selector` and
 * `target_selector`. → `{ error, code: 'invalid_params' }`, or null.
 */
function otherSelectorRefRefusal(params) {
  if (!params || typeof params !== 'object') return null;
  for (const [key, value] of Object.entries(params)) {
    if (REF_FIELDS.has(key) || !/selector$/i.test(key) || typeof value !== 'string') continue;
    if (parseRefSelector(value) !== null || RAW_ARIA_REF.test(value)) {
      return {
        error: `${key} does not take a ref: only selector and target_selector do. Use a CSS, role= or label= selector here, or act on the ref with click or fill.`,
        code: 'invalid_params',
      };
    }
  }
  return null;
}

/**
 * The browser tools' `prepareParams`: → `{ params }` (a new object, the
 * model's own labels removed and the host's added) or `{ error, code }` for a
 * ref that has no label (stale, unknown, no snapshot) or a ref in a field
 * that takes none.
 */
function prepareRefLabels(params, context) {
  if (!params || typeof params !== 'object') return { params };
  const refused = otherSelectorRefRefusal(params);
  if (refused) return refused;
  const next = { ...params };
  delete next.ref_label;
  delete next.target_ref_label;
  const action = String(next.action || '');
  if (!ACTING_ACTIONS.has(action) || isFrameAction(action)) return { params: next };
  for (const [selKey, labelKey] of LABEL_FIELDS) {
    const sel = next[selKey];
    const ref = parseRefSelector(sel);
    if (ref === null) continue;
    let label = null;
    try {
      const b = getBrowser(context);
      if (b && b.isRunning && b.page) {
        b.refLocator(ref); // ref_stale / ref_not_found, in their own words
        label = b.refLabel(ref);
      }
    } catch (err) {
      return { error: err.message || String(err), code: err.code || 'ref_not_found' };
    }
    if (!label) {
      return { error: `${sel} is not in this page's last snapshot. Take a new snapshot.`, code: 'ref_not_found' };
    }
    next[labelKey] = shownRefLabel(label);
    rememberRaw(ref, next[labelKey], label);
  }
  return { params: next };
}

/**
 * Before the handler acts: every ref the call carries a host label for must
 * still name an element with that role and name (read from a fresh snapshot
 * of the page, the same computation the label came from). Throws
 * BrowserRefError ref_changed, or ref_not_found when no browser is running.
 */
async function checkRefLabels(params, context) {
  if (!params || isFrameAction(params.action)) return;
  for (const [selKey, labelKey] of LABEL_FIELDS) {
    const sel = params[selKey];
    const shown = params[labelKey];
    const ref = parseRefSelector(sel);
    if (ref === null || typeof shown !== 'string') continue;
    const b = getBrowser(context);
    if (!b || !b.isRunning || !b.page || typeof b.currentRefLabel !== 'function') {
      throw new BrowserRefError('ref_not_found', `${sel} names nothing: the browser is not running. Start it and take a new snapshot.`);
    }
    const now = await b.currentRefLabel(ref);
    const raws = rawFor(ref, shown);
    const same = now !== null && (raws ? raws.has(now) : shownRefLabel(now) === shown);
    if (!same) {
      const what = now === null ? 'it is no longer in the page\'s snapshot' : `it is now ${shownRefLabel(now)}`;
      throw new BrowserRefError('ref_changed', `The element at ${sel} no longer has the role and name the approval showed (${shown}): ${what}. Nothing was done; take a new snapshot.`);
    }
  }
}

module.exports = { prepareRefLabels, checkRefLabels, shownRefLabel, otherSelectorRefRefusal, LABEL_MAX };
