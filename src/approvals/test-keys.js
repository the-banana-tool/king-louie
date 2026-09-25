// The public halves of the fixed keys in tests/vectors/approval-v1/keys.json.
// Production code never reads tests/, so they are listed here: a node refuses
// an approver whose key is one of these (`test_key`) unless it was built with
// allowTestKeys: true, which only tests set. Anyone can sign with these keys;
// their private halves are published in the repository.
const TEST_DEVICE_KEYS = Object.freeze([
  { name: 'A', device_id: 'd-3vmwrihhdbnit4oi', x: 'krcyG5D6HPx9P3Gi5oaR6OyU9D1gIrc3UD6pIRcDq74', y: '9XqgPXsMAYplX5IZVn-9FRP2sN4oHFRPjnZyfG-GpaI' },
  { name: 'B', device_id: 'd-6xdlbxglhnvfa3lw', x: 'GnDHGfxMVkv5iRyStQIsJbqWKUtPy6ijuA1UiWKlYDc', y: 'LLhIvQ_y0DmIXI_qxojWRICKfjPE_orjZBTwRhje91k' },
  { name: 'C', device_id: 'd-futyo75nn4w4reil', x: 'RscTaDzgRlaVqN4IrrtRgbBZw8hrp00xiIu7B_1AJ6w', y: 'gBam0DF3krccxYdWnKr6fRP4yHKNLKfByP76l8dEw78' }
]);

const TEST_NODE_KEYS = Object.freeze([
  '302a300506032b65700321006f1962549a885918d3d8c5745499194f20289bda3e041e433e4fa15e16558423',
  '302a300506032b65700321004a5a5267be058370e223de879faa852150a2dd0c4113aa634d6259167ec7b950',
  '302a300506032b65700321007d85a245144905192e752ad2c1051643a6e966d934dcbc6baaaabffe1978a725'
]);

function isTestDeviceKey(jwk) {
  return Boolean(jwk) && TEST_DEVICE_KEYS.some((k) => k.x === jwk.x && k.y === jwk.y);
}

function isTestNodeKey(spkiHex) {
  return TEST_NODE_KEYS.includes(String(spkiHex).toLowerCase());
}

module.exports = { TEST_DEVICE_KEYS, TEST_NODE_KEYS, isTestDeviceKey, isTestNodeKey };
