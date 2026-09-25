// Push kinds and the generic alert text: the node name and nothing about the
// action itself (spec §6.5 leak rule). node_name is operator-set text that
// ends up in a push notification shown by the OS, so it is sanitised
// (control characters stripped) and capped before it is ever used.
const KINDS = ['approval', 'grant', 'pairing', 'alert', 'question', 'lease'];
const TITLES = {
  approval: 'Approval needed',
  grant: 'Access request',
  pairing: 'Pairing request',
  alert: 'Alert',
  question: 'Question waiting',
  lease: 'Session request'
};

const MAX_NODE_NAME_LEN = 40;

function sanitizeNodeName(nodeName) {
  if (typeof nodeName !== 'string' || !nodeName) return null;
  // Strip control/formatting characters (including newlines) an operator
  // could use to spoof extra lines or a longer message in the alert text.
  const cleaned = nodeName.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_NODE_NAME_LEN ? `${cleaned.slice(0, MAX_NODE_NAME_LEN - 1)}…` : cleaned;
}

function alertText({ kind = 'approval', node_name: nodeName = null } = {}) {
  const title = TITLES[kind] || TITLES.approval;
  const name = sanitizeNodeName(nodeName);
  return name ? `${title} on ${name}` : title;
}

module.exports = { KINDS, TITLES, alertText };
