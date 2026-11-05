// The public halves of the fixed keys in tests/vectors/approval-v1/keys.json.
// Production code never reads tests/, so they are listed here: a node refuses
// an approver whose key is one of these (`test_key`) unless it was built with
// allowTestKeys: true, which only tests set. Anyone can sign with these keys;
// their private halves are published in the repository.
const TEST_DEVICE_KEYS = Object.freeze([
  Object.freeze({ name: 'A', device_id: 'd-3vmwrihhdbnit4oi', x: 'krcyG5D6HPx9P3Gi5oaR6OyU9D1gIrc3UD6pIRcDq74', y: '9XqgPXsMAYplX5IZVn-9FRP2sN4oHFRPjnZyfG-GpaI' }),
  Object.freeze({ name: 'B', device_id: 'd-6xdlbxglhnvfa3lw', x: 'GnDHGfxMVkv5iRyStQIsJbqWKUtPy6ijuA1UiWKlYDc', y: 'LLhIvQ_y0DmIXI_qxojWRICKfjPE_orjZBTwRhje91k' }),
  Object.freeze({ name: 'C', device_id: 'd-futyo75nn4w4reil', x: 'RscTaDzgRlaVqN4IrrtRgbBZw8hrp00xiIu7B_1AJ6w', y: 'gBam0DF3krccxYdWnKr6fRP4yHKNLKfByP76l8dEw78' }),
  // Read keys (android-slim §8.1, §8.8). A read key has no device id of its
  // own: `device_id` names the device it belongs to. Refused as a record's or
  // an enrollment's read_key like the device keys above.
  Object.freeze({ name: 'A_read', device_id: 'd-3vmwrihhdbnit4oi', read_key: true, x: 'bR4eNDGzasGOPyj1pvmA9ycRieOYKE2JVxoVpjhftII', y: 'epMctH6Kqp-VPnmnb3z8zs8RckTzC2yjbsuor2WWniY' }),
  Object.freeze({ name: 'B_read', device_id: 'd-6xdlbxglhnvfa3lw', read_key: true, x: 'cVt3bucyCwSWInd6zTjQgp27Jl5Bsy_wLUnYZMzSBQY', y: 'jt2NwAHES1iQ9RYN8GvJNzrNVL4W2FwJQ5oH5CssLiU' }),
  // Box keys (sealed phones, R-SP-1): key agreement only, and no id of their
  // own, so `device_id` names the device, as for a read key.
  Object.freeze({ name: 'A_box', device_id: 'd-3vmwrihhdbnit4oi', box_key: true, x: 'AUcENPOiBeZMUCUoLPAf4iXiRVQGO2XcbpR_GbvA47Y', y: '3wSU8i6hc3-PXZztNVJm2LpENtj87rbex4qhJa3VQ-4' }),
  Object.freeze({ name: 'B_box', device_id: 'd-6xdlbxglhnvfa3lw', box_key: true, x: 'h6PCItS4cVIGuDrKEcllyTPlzqJD3V4yStB8RYEEhlc', y: 'Mb8Qva8gF3CiDXhJpmWn5R0JV1QbHmocdj4DV-pbqKA' })
]);

const TEST_NODE_KEYS = Object.freeze([
  Object.freeze('302a300506032b65700321006f1962549a885918d3d8c5745499194f20289bda3e041e433e4fa15e16558423'),
  Object.freeze('302a300506032b65700321004a5a5267be058370e223de879faa852150a2dd0c4113aa634d6259167ec7b950'),
  Object.freeze('302a300506032b65700321007d85a245144905192e752ad2c1051643a6e966d934dcbc6baaaabffe1978a725')
]);

// The public half of web-01's box key (R-SP-3).
const TEST_NODE_BOX_KEYS = Object.freeze([
  Object.freeze({ kty: 'EC', crv: 'P-256', x: 'tsYG6ffUpbjs90RzwFQyEFqK_xkzbO2XfAU-y73MJMw', y: 'qSlwf8klRGPUSpSAwoGWvxFheOGNKVkm4axOrZeUJYQ' })
]);

// Compares raw x/y strings, not curve points, so callers must validate the
// JWK shape (isDeviceJwk) first — an unvalidated jwk here could false-negative
// on an equivalent encoding, or throw on a non-string x/y.
function isTestDeviceKey(jwk) {
  return Boolean(jwk) && TEST_DEVICE_KEYS.some((k) => k.x === jwk.x && k.y === jwk.y);
}

// A record, or an enrollment's device, whose device key, read key
// (android-slim §8.8) or box key (R-SP-1) is a published test key. A holder
// without one of the last two is judged on what it has.
function hasTestKey(holder) {
  if (!holder) return false;
  const readKey = holder.read_key === undefined || holder.read_key === null ? null : holder.read_key;
  return isTestDeviceKey(holder.public_key) || isTestDeviceKey(readKey) || isTestDeviceKey(holder.box_key);
}

function isTestNodeKey(spkiHex) {
  return TEST_NODE_KEYS.includes(String(spkiHex).toLowerCase());
}

// The raw Ed25519 keys in tests/vectors/window-v1/keys.json, in hex (R-RW-36): never
// enrolled as a window, whatever role the file gives them.
const TEST_WINDOW_KEYS = Object.freeze([
  '0143e4bbd5f309bad630dd7f5c12fb94e342d3cc7e607659be3afe5025bc49e7',
  'edca9c0b4e6bad45904292f95fc4cef35ec31e747556bd09fb29e4d3dfebf542',
  '5302f42ee870a81441294bb56c6942200398b2b3f78236778aabb2c04f47ade7',
  '8d2672764884fd008e65ff07dde4993f90fe38e002c401c22ea4347862f1b3ae'
]);

function isTestWindowKey(raw) {
  return TEST_WINDOW_KEYS.includes(Buffer.from(raw).toString('hex'));
}

// As isTestDeviceKey: raw x/y strings, so validate the JWK's shape first.
function isTestNodeBoxKey(jwk) {
  return Boolean(jwk) && TEST_NODE_BOX_KEYS.some((k) => k.x === jwk.x && k.y === jwk.y);
}

module.exports = { TEST_WINDOW_KEYS, isTestWindowKey, TEST_DEVICE_KEYS, TEST_NODE_KEYS, TEST_NODE_BOX_KEYS, isTestDeviceKey, isTestNodeKey, isTestNodeBoxKey, hasTestKey };
