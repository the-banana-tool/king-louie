// tests/mobile-android-relay-keys.test.js
//
// android-slim §8.1, §8.4, §12: the Android app holds two keys and signs each
// relay route with the key §8.4 names. The app module has no test target, so
// this reads the Kotlin sources (as tests/mobile-lease-apps.test.js does): it
// shows the rules are written into the code, not that the app behaves.
//
// The route table is read from tests/frontdoor-phone-routes.test.js
// (`ROUTE_AUTH`, the relay side's source of truth), never copied here.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const KT = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];

function routeTable() {
  const text = read('tests', 'frontdoor-phone-routes.test.js');
  const a = text.indexOf('const ROUTE_AUTH = Object.freeze([');
  const b = text.indexOf(']);', a);
  assert.ok(a >= 0 && b > a, 'ROUTE_AUTH in tests/frontdoor-phone-routes.test.js');
  const rows = [...text.slice(a, b).matchAll(/\['(GET|POST|PUT|DELETE)', '([^']+)', '([a-z]+)'\]/g)].map((m) => ({ method: m[1], pattern: m[2], auth: m[3] }));
  assert.ok(rows.length > 30);
  return rows;
}

// A path as the Kotlin source writes it ("/v1/leases/${segment(leaseId)}/$action?x=$y"), without its
// query, matched against a table pattern ("/v1/leases/{lease_id}/watch"). `$action` matches any segment.
function routeFor(table, method, kotlinPath) {
  const p = kotlinPath.split('?')[0].replace(/\$\{[^}]*\}/g, '\u0000').replace(/\$[A-Za-z_]+/g, '\u0000');
  const hits = table.filter((r) => {
    if (r.method !== method) return false;
    const want = r.pattern.split('/');
    const got = p.split('/');
    return want.length === got.length && want.every((w, i) => got[i] === '\u0000' || w === got[i] || (/^\{.*\}$/.test(w) && got[i] === '\u0000'));
  });
  return hits;
}

// Every call RelayApi makes: request(...) and exchange(...) with a literal method and path, and reply(path, …).
function calls(api) {
  const out = [];
  for (const m of api.matchAll(/\b(request|exchange)\("(GET|POST|PUT)", (?:if \([^)]*\) )?"([^"]+)"(?: else "[^"]+")?, ([A-Za-z_.]+)/g)) {
    out.push({ via: m[1], method: m[2], path: m[3], key: m[4] });
  }
  for (const m of api.matchAll(/\breply\("([^"]+)", /g)) out.push({ via: 'reply', method: 'POST', path: m[1], key: 'reply' });
  return out;
}

describe('Android: two keys, and the key each relay route is signed with (android-slim §8.1, §8.4)', () => {
  it('ReadKey.kt makes the read key §8.1 describes', () => {
    const rk = read(...KT, 'ReadKey.kt');
    assert.match(rk, /const val ALIAS = "kl\.read-key"/);
    assert.match(rk, /\.setUserAuthenticationRequired\(false\)/);
    assert.match(rk, /\.setUnlockedDeviceRequired\(true\)/);
    assert.match(rk, /\.setInvalidatedByBiometricEnrollment\(false\)/);
    assert.match(rk, /\.setIsStrongBoxBacked\(strongBox\)/);
    assert.match(rk, /catch \(e: StrongBoxUnavailableException\)/);
    assert.match(rk, /KeyProperties\.PURPOSE_SIGN/);
    assert.match(rk, /Messages\.readKeyFingerprint\(x, y\)/);
    assert.match(rk, /Messages\.jwk\(x, y\)/);
    assert.ok(!rk.includes('BiometricPrompt'), 'the read key never prompts');
  });

  it('DeviceKey.create also makes the read key, and delete removes both', () => {
    const dk = read(...KT, 'DeviceKey.kt');
    const create = dk.slice(dk.indexOf('fun create(): DeviceKey'), dk.indexOf('fun delete()'));
    assert.match(create, /ReadKey\.create\(\)/);
    const del = dk.slice(dk.indexOf('fun delete()'));
    assert.match(del, /keyStore\(\)\.deleteEntry\(ALIAS\)/);
    assert.match(del, /ReadKey\.delete\(\)/);
  });

  it('RelayApi has two signers and sends X-KL-Key: read with the read string', () => {
    const api = read(...KT, 'RelayApi.kt');
    assert.match(api, /private val deviceSigner: \(suspend \(ByteArray\) -> ByteArray\)\?/);
    assert.match(api, /private val readSigner: \(suspend \(ByteArray\) -> ByteArray\)\?/);
    assert.match(api, /Messages\.phoneAuthString\(method, pathWithQuery, timestamp, bytes, used\)/);
    assert.match(api, /headers\["X-KL-Key"\] = PhoneKey\.READ\.header/);
    assert.ok(!/fun history\(/.test(api), 'history goes (§12)');
    assert.ok(!/fun auditStatus\(/.test(api), 'the app no longer reads audit-status (§8.4)');
    assert.match(api, /private val longPolls = Semaphore\(2\)/, 'the long-poll semaphore stays');
  });

  it('every route RelayApi calls is in the relay table, and the read key goes only to a `read` route', () => {
    const table = routeTable();
    const api = read(...KT, 'RelayApi.kt');
    const found = calls(api);
    assert.ok(found.length >= 30, `found ${found.length} calls`);
    // reply() is the front door's decision helper; its body is a device-key envelope.
    assert.match(api, /private suspend fun reply\(path: String, envelope: Envelope\): FrontDoorReply \{\n\s+val \(status, body\) = exchange\("POST", path, ENVELOPE, envelope\.json\)/);
    const allowed = { READ: ['read'], ENVELOPE: ['read'], DEVICE: ['device'], NONE: ['none', 'code', 'invite'], reply: ['read'], route: ['read'] };
    for (const c of found) {
      const hits = routeFor(table, c.method, c.path);
      assert.equal(hits.length >= 1, true, `${c.method} ${c.path} is in ROUTE_AUTH`);
      const kinds = allowed[c.key];
      assert.ok(kinds, `${c.method} ${c.path}: a key RelayApi names (${c.key})`);
      for (const h of hits) assert.ok(kinds.includes(h.auth), `${c.method} ${c.path} signed ${c.key}, table says ${h.auth}`);
    }
    // The routes whose key is chosen in the function: kl.device.read_key (device key first, then the
    // envelope rule, §8.7) and a lease envelope (a watch is read-only transport; grant, deny and
    // revoke are decisions).
    const keyed = found.filter((c) => c.key === 'route');
    assert.deepEqual(keyed.map((c) => `${c.method} ${c.path}`).sort(), ['POST /v1/devices/read-key', 'POST /v1/leases/${segment(leaseId)}/$action']);
    assert.match(api, /val route = if \(key == PhoneKey\.DEVICE\) DEVICE else ENVELOPE\n\s+return request\("POST", "\/v1\/devices\/read-key", route, statement\.json\)/);
    assert.match(api, /val route = if \(action == "watch"\) READ else ENVELOPE\n\s+return request\("POST", "\/v1\/leases\/\$\{segment\(leaseId\)\}\/\$action", route, envelope\.json\)/);
    // ENVELOPE carries an envelope the device key signed, and only that: every such call's body is one.
    for (const m of api.matchAll(/\b(?:request|exchange)\("(?:POST|PUT)", [^\n]*?, ENVELOPE, ([a-z]+)\.json\)/g)) {
      assert.ok(['envelope', 'statement'].includes(m[1]), `an ENVELOPE request sends an envelope (${m[0]})`);
    }
    // Presence (§9): read key, { foreground, at }.
    assert.match(api, /suspend fun presence\(foreground: Boolean\)/);
    assert.ok(found.some((c) => c.method === 'POST' && c.path === '/v1/presence' && c.key === 'READ'));
    // The push token rides the read key (spec 3 R5).
    assert.ok(found.some((c) => c.method === 'PUT' && c.path === '/v1/push-token' && c.key === 'READ'));
  });

  it('a read-only request with no read key fails at once and never prompts; only an envelope may travel device-signed (P4)', () => {
    const api = read(...KT, 'RelayApi.kt');
    assert.match(api, /enum class RouteKey \{ READ, ENVELOPE, DEVICE \}/);
    const exchange = api.slice(api.indexOf('suspend fun exchange('), api.indexOf('private fun send('));
    // READ: the read key or a clear error, never the device key.
    assert.match(exchange, /READ -> \(readSigner \?: throw RelayException\(0, READ_KEY_NOT_SET_UP, READ_KEY_NOT_SET_UP_TEXT\)\) to PhoneKey\.READ/);
    // ENVELOPE: the read key, else (a phone enrolled before it, until its set-up) the device key.
    assert.match(exchange, /ENVELOPE -> if \(readSigner != null\) readSigner to PhoneKey\.READ else deviceSigner to PhoneKey\.DEVICE/);
    assert.match(exchange, /DEVICE -> deviceSigner to PhoneKey\.DEVICE/);
    assert.match(api, /const val READ_KEY_NOT_SET_UP = "read_key_not_set_up"/);
    // Every GET is READ or unsigned, but the one that claims a client by its code (DEVICE).
    for (const c of calls(api).filter((x) => x.method === 'GET')) {
      if (c.path.startsWith('/v1/grants/pending')) assert.equal(c.key, 'DEVICE', c.path);
      else assert.ok(['READ', 'NONE'].includes(c.key), `GET ${c.path} is ${c.key}`);
    }
    // Presence and the push token are READ.
    for (const p of ['/v1/presence', '/v1/push-token']) assert.ok(calls(api).some((c) => c.path === p && c.key === 'READ'), p);
  });

  it('AppModel gives RelayApi the read key\'s signer, and the read key never prompts', () => {
    const model = read(...KT, 'AppModel.kt');
    assert.match(model, /RelayApi\(url, pin, k\.deviceId, \{ data -> sign\(k, data, "Check your relay", "Signs this phone's request to the relay"\) \}, readSigner\(\)\)/);
    // The enrollment carries the read key when the phone has one (§8.2).
    assert.match(model, /Messages\.device\(k\.deviceId, name, "android", k\.x, k\.y, readKey\?\.jwk\)/);
  });
});
