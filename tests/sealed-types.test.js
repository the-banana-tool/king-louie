// tests/sealed-types.test.js
//
// Which message types are content, and that each has a validator that takes its
// sealed shape (sealed phones, R-SP-4, R-SP-14). Nothing here tells a type's
// content from its clear part but SEAL_SPLIT.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SEAL_SPLIT, sealContent, splitMessage } = require('../src/approvals/seal');
const { generateBoxKey } = require('../src/approvals/node-box-key');
const { validateMessage } = require('../src/approvals/messages');
// Each registers its own validators.
require('../src/gui/lease-protocol');
require('../src/channels/mobile-app-channel');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');

// The six of R-SP-4. A new type a node and a phone exchange content in joins
// this list and SEAL_SPLIT together.
const CONTENT_TYPES = ['kl.approval.request', 'kl.lease.request', 'kl.lease.status', 'kl.lease.view', 'kl.question.ask', 'kl.question.answer'];
// The types whose sealed shape a later task's validator takes.
const NOT_YET = {};

const node = testNodeIdentity({ box: true });
const phone = createFakePhone({ boxKey: true });
const NOW = '2026-09-23T18:04:11.201Z';
const LATER = '2026-09-23T18:09:11.201Z';
const NONCE = 'n'.repeat(43);
const HASH = 'h'.repeat(43);
const UUID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'c'.repeat(22);

// A whole message of each type, clear part and content.
const FULL = {
  'kl.approval.request': {
    v: 1, type: 'kl.approval.request', request_id: UUID, node_id: node.nodeId, node_name: 'web-01', action_hash: HASH, created_at: NOW, expires_at: LATER, nonce: NONCE, node_box: node.box.jwk,
    action: { kind: 'tool', name: 'Bash', params: { command: 'ls' }, cwd: null, summary: 'Bash(ls)' }, origin: { client: 'gateway', session: null, job_id: null }, salt: 's'.repeat(43)
  },
  'kl.lease.request': {
    v: 1, type: 'kl.lease.request', request_id: UUID, lease_id: '22222222-2222-4222-8222-222222222222', node_id: node.nodeId, node_name: 'web-01', lease_hash: HASH, created_at: NOW, expires_at: LATER, nonce: NONCE, node_box: node.box.jwk,
    lease: { kind: 'computer_use' }, origin: { client: 'gateway', session: null, job_id: null }, salt: 's'.repeat(43)
  },
  'kl.lease.status': {
    v: 1, type: 'kl.lease.status', node_id: node.nodeId, lease_id: UUID, seq: 1, at: NOW, state: 'active', locked: false, reason: null, expires_at: LATER, contact_token: TOKEN, granted_by: null, kind: 'take', unattended: true, name: 'A demo'
  },
  'kl.lease.view': {
    v: 1, type: 'kl.lease.view', node_id: node.nodeId, lease_id: UUID, seq: 1, at: NOW, to_device: phone.deviceId, state: 'active', locked: false, remaining_s: 60, contact_token: TOKEN,
    foreground: { app_id: null, matches: false }, frame: null, frame_dropped: false, actions: []
  },
  'kl.question.ask': {
    v: 1, type: 'kl.question.ask', node_id: node.nodeId, token: 'ABCD23', kind: 'question', urgency: 'normal', expires_at: LATER, node_box: node.box.jwk,
    case_id: 'case-1', question_id: 'q-0001', case_title: 'Lakeside lot', text: 'Which one?', options: []
  },
  'kl.question.answer': {
    v: 1, type: 'kl.question.answer', node_id: node.nodeId, token: 'ABCD23', device_id: phone.deviceId, nonce: NONCE, signed_at: NOW,
    case_id: 'case-1', question_id: 'q-0001', answer: { text: 'The first' }
  }
};

function sealedForm(type) {
  const { clear, content } = splitMessage(type, FULL[type]);
  const senderId = type === 'kl.question.answer' ? phone.deviceId : node.nodeId;
  const recipientId = type === 'kl.question.answer' ? node.nodeId : phone.deviceId;
  return sealContent({ type, senderId, clear, content, recipients: { [recipientId]: generateBoxKey().jwk } });
}

describe('sealed types', () => {
  it('every content type is in SEAL_SPLIT, and nothing else is', () => {
    assert.deepEqual(Object.keys(SEAL_SPLIT).sort(), [...CONTENT_TYPES].sort());
  });

  // A type a later task owns stays a todo until that task's validator takes it:
  // node:test runs it and does not fail the suite. The task removes its NOT_YET line.
  for (const type of Object.keys(SEAL_SPLIT)) {
    it(`${type} has a validator that takes its sealed shape`, NOT_YET[type] ? { todo: NOT_YET[type] } : {}, () => {
      assert.equal(validateMessage(type, sealedForm(type)), null);
    });
  }

  it('a sealed request that also holds a sealed key in clear is refused', () => {
    const sealed = sealedForm('kl.approval.request');
    assert.equal(validateMessage('kl.approval.request', { ...sealed, action: FULL['kl.approval.request'].action }), 'malformed');
    const { node_box: dropped, ...withoutBox } = sealed;
    assert.ok(dropped);
    assert.equal(validateMessage('kl.approval.request', withoutBox), 'malformed');
    assert.equal(validateMessage('kl.approval.request', { ...sealed, node_box: { kty: 'EC' } }), 'malformed');
    assert.equal(validateMessage('kl.approval.request', { ...sealed, action_hash: 'short' }), 'malformed');
  });
});

describe('sealContent in the source', () => {
  // A reused ephemeral repeats keystream under the wrap's zero iv, so what the
  // vectors inject never reaches production.
  const SRC = path.join(__dirname, '..', 'src');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.js') ? [full] : [];
  });

  // The text from `sealContent(` to its closing parenthesis.
  function argumentsAt(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) return text.slice(open + 1, i);
      }
    }
    throw new Error('unbalanced call');
  }

  it('nothing under src/ passes ephemeral or random to sealContent', () => {
    let calls = 0;
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      const isSeal = path.relative(SRC, file).replace(/\\/g, '/') === 'approvals/seal.js';
      for (const match of text.matchAll(/\bsealContent\b(\s*\()?/g)) {
        if (!match[1]) {
          // A bare name is an import or an export; an alias would dodge the check below.
          const before = text.slice(Math.max(0, match.index - 200), match.index);
          assert.doesNotMatch(text.slice(match.index, match.index + 40), /^sealContent\s*:/, `${file} renames sealContent`);
          assert.doesNotMatch(before, /=\s*$/, `${file} aliases sealContent`);
          continue;
        }
        if (isSeal) continue; // its definition, which has to name them
        calls += 1;
        const args = argumentsAt(text, match.index + match[0].length - 1);
        assert.doesNotMatch(args, /\b(ephemeral|random)\b/, `${file} passes one`);
        assert.doesNotMatch(args, /\.\.\./, `${file} spreads into the call, which could carry one`);
      }
    }
    assert.ok(calls >= 1, 'the walk found the real caller');
  });
});
