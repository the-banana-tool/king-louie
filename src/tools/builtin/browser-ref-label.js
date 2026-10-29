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

const { ACTING_ACTIONS } = require('../browser-acting');
const { plainLineProblem } = require('../../cases/hidden-chars');
const { getBrowser } = require('./browser-registry');
const { BrowserRefError } = require('../../browser/playwright-browser');

const LABEL_MAX = 80;
const LABEL_FIELDS = [['selector', 'ref_label'], ['target_selector', 'target_ref_label']];

// params object → { ref_label: raw, target_ref_label: raw }: the labels as the
// snapshot gave them, before hiding or cutting, so the run-time comparison is
// exact (two names hidden alike, or alike in their first 80 characters, are
// still told apart). Keyed by the very object the executor runs.
const approvedRaw = new WeakMap();

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

const isRef = (sel) => typeof sel === 'string' && sel.startsWith('ref=');

/**
 * The browser tools' `prepareParams`: → `{ params }` (a new object, the
 * model's own labels removed and the host's added) or `{ error, code }` for a
 * ref that has no label (stale, unknown, no snapshot).
 */
function prepareRefLabels(params, context) {
  if (!params || typeof params !== 'object') return { params };
  const next = { ...params };
  delete next.ref_label;
  delete next.target_ref_label;
  const action = String(next.action || '');
  if (!ACTING_ACTIONS.has(action) || /_in_frame$/.test(action)) return { params: next };
  const raw = {};
  for (const [selKey, labelKey] of LABEL_FIELDS) {
    const sel = next[selKey];
    if (!isRef(sel)) continue;
    const ref = sel.slice(4);
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
    raw[labelKey] = label;
    next[labelKey] = shownRefLabel(label);
  }
  if (Object.keys(raw).length) approvedRaw.set(next, raw);
  return { params: next };
}

/**
 * Before the handler acts: every ref the call carries a host label for must
 * still name an element with that role and name (read from a fresh snapshot
 * of the page, the same computation the label came from). Throws
 * BrowserRefError ref_changed.
 */
async function checkRefLabels(params, context) {
  if (!params || /_in_frame$/.test(String(params.action))) return;
  const raw = approvedRaw.get(params) || {};
  for (const [selKey, labelKey] of LABEL_FIELDS) {
    const sel = params[selKey];
    const shown = params[labelKey];
    if (!isRef(sel) || typeof shown !== 'string') continue;
    const ref = sel.slice(4);
    const b = getBrowser(context);
    const now = await b.currentRefLabel(ref);
    const same = now !== null && (raw[labelKey] !== undefined ? now === raw[labelKey] : shownRefLabel(now) === shown);
    if (!same) {
      const what = now === null ? 'it is no longer in the page\'s snapshot' : `it is now ${shownRefLabel(now)}`;
      throw new BrowserRefError('ref_changed', `The element at ${sel} no longer has the role and name the approval showed (${shown}): ${what}. Nothing was done; take a new snapshot.`);
    }
  }
}

module.exports = { prepareRefLabels, checkRefLabels, shownRefLabel, LABEL_MAX };
