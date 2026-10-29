// The FCM credential (push spec §8, R-PU-1): a Google service-account JSON
// key at the absolute path relay.push.fcm.service_account_file names. It is
// checked when the relay starts, so a key missing a field refuses the start
// instead of failing at the first push. Every refusal names the path and, for
// a missing field, the field: never a value from the file (the file holds the
// private key), and never the JSON parser's message (it can quote the text).
// Shared by the relay's senders, doctor's push row and `relay push-test`.
const fs = require('fs');

const REQUIRED_FIELDS = ['project_id', 'client_email', 'private_key'];

function credentialError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

function readServiceAccountFile(file, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  let text;
  try {
    text = readFile(file);
  } catch (err) {
    const reason = err && typeof err.code === 'string' ? err.code : 'read failed';
    throw credentialError('PUSH_CREDENTIAL_UNREADABLE', `relay.push.fcm.service_account_file ${file} cannot be read (${reason})`, { cause: err });
  }
  let key;
  try {
    key = JSON.parse(text);
  } catch {
    key = undefined;
  }
  if (!key || typeof key !== 'object' || Array.isArray(key)) {
    throw credentialError('PUSH_CREDENTIAL_INVALID', `relay.push.fcm.service_account_file ${file} is not a JSON service-account key (it does not parse as a JSON object)`);
  }
  if (key.type !== 'service_account') {
    throw credentialError('PUSH_CREDENTIAL_INVALID', `relay.push.fcm.service_account_file ${file} is not a service-account key: "type" must be "service_account"`, { field: 'type' });
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof key[field] !== 'string' || !key[field]) {
      throw credentialError('PUSH_CREDENTIAL_INVALID', `relay.push.fcm.service_account_file ${file} has no "${field}" (a non-empty string)`, { field });
    }
  }
  return key;
}

module.exports = { readServiceAccountFile, REQUIRED_FIELDS };
