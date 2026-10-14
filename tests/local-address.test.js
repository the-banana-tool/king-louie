'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyAddress,
  canonicalAddress,
  parseBaseUrl,
  resolveAndPin,
  checkPinned,
  gradeOf,
  LocalAddressError,
  ADDRESS_CLASSES,
} = require('../src/models/local-address');

const FP = 'ab'.repeat(32);
const noLookup = async () => { throw new Error('lookup must not be called'); };
const fakeLookup = (answers, seen = []) => async (hostname, options) => {
  seen.push({ hostname, options });
  return answers;
};

async function rejection(promise) {
  let value;
  try {
    value = await promise;
  } catch (err) {
    return err;
  }
  assert.fail(`expected a rejection, got ${JSON.stringify(value)}`);
}

function urlError(raw) {
  try {
    parseBaseUrl(raw);
  } catch (err) {
    return err;
  }
  assert.fail(`expected ${JSON.stringify(raw)} to be refused`);
}

describe('local-address', () => {
  describe('classifyAddress', () => {
    it('R-LI-5: every public spelling is refused', () => {
      for (const ip of [
        '198.51.100.7', '203.0.113.9', '192.0.2.1', '2001:db8::1',
        '64:ff9b::c633:6407', '64:ff9b::10.0.0.1', '64:ff9b:1::a00:1',
        '2002:c633:6407::1', '2002:7f00:1::1', '2002:c0a8:132::1',
        '::ffff:198.51.100.7', '::ffff:c633:6407', '::FFFF:C633:6407',
        '224.0.0.1', '239.255.255.250', 'ff02::1', 'ff05::2',
        '255.255.255.255', '::ffff:255.255.255.255', '::ffff:224.0.0.1',
        '8.8.8.8', '2606:4700:4700::1111',
      ]) {
        assert.equal(classifyAddress(ip), 'public', ip);
      }
    });

    it('an IPv4-compatible or IPv4-translated IPv6 spelling of a private address is public', () => {
      for (const ip of [
        '::127.0.0.1', '::7f00:1', '::10.0.0.1', '::192.168.1.50', '::2',
        '::ffff:0:127.0.0.1', '::ffff:0:7f00:1', '0:0:0:0:0:fffe:7f00:1',
        '0:0:0:0:1:ffff:7f00:1', '1::ffff:7f00:1',
      ]) {
        assert.equal(classifyAddress(ip), 'public', ip);
      }
    });

    it('loopback', () => {
      for (const ip of [
        '127.0.0.1', '127.255.255.254', '127.0.0.0', '::1', '0:0:0:0:0:0:0:1',
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:0001', '0:0:0:0:0:ffff:7f00:1',
      ]) {
        assert.equal(classifyAddress(ip), 'loopback', ip);
      }
    });

    it('lan', () => {
      for (const ip of [
        '10.1.2.3', '10.0.0.0', '10.255.255.255', '172.16.0.1', '172.31.255.255',
        '192.168.1.50', '192.168.255.255', 'fd12:3456::1', 'fc00::1', 'FDFF:FFFF::1',
        '::ffff:192.168.1.50', '::ffff:c0a8:132', '::ffff:10.1.2.3',
      ]) {
        assert.equal(classifyAddress(ip), 'lan', ip);
      }
      for (const ip of ['172.32.0.1', '172.15.255.255', '192.169.0.1', '192.167.255.255', '11.0.0.1', '9.255.255.255', 'fe00::1', 'fbff::1']) {
        assert.equal(classifyAddress(ip), 'public', ip);
      }
    });

    it('link-local, in both families and with a zone id', () => {
      for (const ip of ['169.254.169.254', '169.254.0.1', 'fe80::1', 'febf::1', 'fe80::1%eth0', 'fe80::1%12', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe']) {
        assert.equal(classifyAddress(ip), 'link-local', ip);
      }
      assert.equal(classifyAddress('fec0::1'), 'public');
      assert.equal(classifyAddress('169.255.0.1'), 'public');
    });

    it('an address with a zone id is never loopback, lan or cgnat', () => {
      for (const ip of ['::1%lo0', 'fd12:3456::1%eth0', '::ffff:127.0.0.1%1', '::ffff:100.64.0.1%1']) {
        const cls = classifyAddress(ip);
        assert.ok(cls !== 'loopback' && cls !== 'lan' && cls !== 'cgnat', `${ip} was ${cls}`);
      }
    });

    it('unspecified', () => {
      for (const ip of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '::ffff:0:0']) {
        assert.equal(classifyAddress(ip), 'unspecified', ip);
      }
      assert.equal(classifyAddress('0.1.2.3'), 'public');
    });

    it('cgnat', () => {
      for (const ip of ['100.64.0.1', '100.127.255.255', '::ffff:100.64.0.1']) {
        assert.equal(classifyAddress(ip), 'cgnat', ip);
      }
      assert.equal(classifyAddress('100.128.0.1'), 'public');
      assert.equal(classifyAddress('100.63.255.255'), 'public');
    });

    it('throws TypeError for anything that is not one IP literal', () => {
      for (const bad of [
        'workstation', '', ' 127.0.0.1', '127.0.0.1 ', '127.0.0.1\n', '127.1', '2130706433',
        '0177.0.0.1', '0x7f.0.0.1', '127.0.0.01', '127.0.0.1.', '[::1]', '127.0.0.1:80',
        '127.0.0.1/8', '1.2.3.4.5', '::1::', 'fe80::1%', null, undefined, 2130706433,
        {}, ['127.0.0.1'],
      ]) {
        assert.throws(() => classifyAddress(bad), TypeError, String(bad));
      }
    });

    it('every answer is one of ADDRESS_CLASSES', () => {
      assert.deepEqual([...ADDRESS_CLASSES], ['loopback', 'lan', 'cgnat', 'link-local', 'unspecified', 'public']);
      assert.ok(Object.isFrozen(ADDRESS_CLASSES));
    });
  });

  describe('canonicalAddress', () => {
    it('unwraps an IPv4-mapped address and lowers and compresses IPv6', () => {
      assert.equal(canonicalAddress('::ffff:127.0.0.1'), '127.0.0.1');
      assert.equal(canonicalAddress('::FFFF:C0A8:0132'), '192.168.1.50');
      assert.equal(canonicalAddress('0:0:0:0:0:0:0:1'), '::1');
      assert.equal(canonicalAddress('FD12:3456:0:0:0:0:0:1'), 'fd12:3456::1');
      assert.equal(canonicalAddress('10.1.2.3'), '10.1.2.3');
      assert.equal(canonicalAddress('fe80::1%eth0'), 'fe80::1%eth0');
      assert.throws(() => canonicalAddress('workstation'), TypeError);
    });
  });

  describe('parseBaseUrl', () => {
    it('reads the origin, the port and the host', () => {
      assert.deepEqual(parseBaseUrl('http://127.0.0.1:11434/'), {
        href: 'http://127.0.0.1:11434', protocol: 'http:', hostname: '127.0.0.1', port: 11434, isIpLiteral: true,
      });
      const named = parseBaseUrl('https://gpu-box.example.com');
      assert.equal(named.port, 443);
      assert.equal(named.isIpLiteral, false);
      assert.equal(named.hostname, 'gpu-box.example.com');
      assert.equal(named.href, 'https://gpu-box.example.com');
      assert.equal(parseBaseUrl('http://127.0.0.1').port, 80);
      const v6 = parseBaseUrl('http://[::1]:8080');
      assert.equal(v6.hostname, '::1');
      assert.equal(v6.isIpLiteral, true);
      assert.equal(v6.href, 'http://[::1]:8080');
      assert.equal(parseBaseUrl('http://127.0.0.1:8080/api/').href, 'http://127.0.0.1:8080/api');
      assert.equal(parseBaseUrl('HTTP://GPU-Box.Example.COM:8000').hostname, 'gpu-box.example.com');
    });

    it('refuses what is not a plain http or https origin', () => {
      for (const raw of [
        'ftp://127.0.0.1', 'file:///etc/hosts', 'ws://127.0.0.1:8080', 'javascript:alert(1)',
        'http://user:pw@127.0.0.1', 'http://user@127.0.0.1', 'http://:pw@127.0.0.1',
        'http://127.0.0.1@gpu-box.example.com', 'http://127.0.0.1/?a=1', 'http://127.0.0.1/?',
        'http://127.0.0.1/#x', 'http://127.0.0.1/#', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
        'http://127.0.0.1:-1', 'not a url', '', '127.0.0.1:11434', '//127.0.0.1', 'http://',
        'http://[fe80::1%25eth0]:8080', 'http://[fe80::1%eth0]:8080',
        ' http://127.0.0.1', 'http://127.0.0.1 ', 'http://127.0.0.1\n', 'http://127.0\t.0.1',
        'http://127.0.0.1\\@gpu-box.example.com', 'http:\\\\127.0.0.1',
        'http://127.0.0.1/a/../b', 'http://127.0.0.1/%2e%2e/x',
        null, undefined, 42, {}, new URL('http://127.0.0.1'),
      ]) {
        const err = urlError(raw);
        assert.ok(err instanceof LocalAddressError, String(raw));
        assert.equal(err.code, 'LOCAL_URL_INVALID', String(raw));
      }
    });

    it('a number spelling of an IPv4 host is read as the address it means', () => {
      for (const raw of ['http://2130706433', 'http://0177.0.0.1', 'http://0x7f.0.0.1', 'http://127.1', 'http://127.0.0.1.', 'http://0x7f000001']) {
        const parsed = parseBaseUrl(raw);
        assert.equal(parsed.hostname, '127.0.0.1', raw);
        assert.equal(parsed.isIpLiteral, true, raw);
        assert.equal(parsed.href, 'http://127.0.0.1', raw);
      }
      assert.equal(parseBaseUrl('http://3325256711').hostname, '198.51.100.7');
    });

    it('an international name becomes its punycode form and stays a name', () => {
      const parsed = parseBaseUrl('http://bücher.example:8000');
      assert.equal(parsed.hostname, 'xn--bcher-kva.example');
      assert.equal(parsed.isIpLiteral, false);
      assert.equal(parseBaseUrl('http://localhost.:11434').isIpLiteral, false);
    });
  });

  describe('resolveAndPin', () => {
    it('an IP literal is its own answer and nothing is looked up', async () => {
      const at = new Date('2026-10-13T09:00:00.000Z');
      const pinned = await resolveAndPin('http://127.0.0.1:11434', { lookup: noLookup, now: () => at });
      assert.deepEqual(pinned, { addresses: ['127.0.0.1'], class: 'loopback', at: '2026-10-13T09:00:00.000Z' });
      assert.deepEqual((await resolveAndPin('http://[::1]:8080', { lookup: noLookup })).addresses, ['::1']);
      assert.equal((await resolveAndPin('http://192.168.1.50:1234', { lookup: noLookup })).class, 'lan');
      assert.equal((await resolveAndPin('http://[fd12:3456::1]:1234', { lookup: noLookup })).class, 'lan');
    });

    it('an IPv4-mapped literal is pinned as its IPv4 address', async () => {
      const pinned = await resolveAndPin('http://[::ffff:127.0.0.1]:11434', { lookup: noLookup });
      assert.deepEqual(pinned.addresses, ['127.0.0.1']);
      assert.equal(pinned.class, 'loopback');
    });

    it('a name is resolved once, with all: true', async () => {
      const seen = [];
      const pinned = await resolveAndPin('https://gpu-box.example.com:8443', {
        lookup: fakeLookup([{ address: '192.168.1.50', family: 4 }], seen),
      });
      assert.deepEqual(pinned.addresses, ['192.168.1.50']);
      assert.equal(pinned.class, 'lan');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].hostname, 'gpu-box.example.com');
      assert.equal(seen[0].options.all, true);
    });

    it('R-LI-5: a name with one public answer is refused', async () => {
      const err = await rejection(resolveAndPin('http://gpu-box.example.com:8000', {
        lookup: fakeLookup([{ address: '192.168.1.50', family: 4 }, { address: '203.0.113.9', family: 4 }]),
      }));
      assert.ok(err instanceof LocalAddressError);
      assert.equal(err.code, 'LOCAL_ADDRESS_PUBLIC');
      assert.deepEqual(err.addresses, ['192.168.1.50', '203.0.113.9']);
      assert.deepEqual(err.refused, [{ address: '203.0.113.9', class: 'public' }]);
    });

    it('R-LI-5: a public answer in any spelling or family is refused', async () => {
      for (const address of ['::ffff:203.0.113.9', '2001:db8::1', '64:ff9b::c0a8:132', '2002:c0a8:132::1', '::192.168.1.50', '224.0.0.1', 'fe80::1%eth0', '169.254.169.254', '0.0.0.0', '::']) {
        const err = await rejection(resolveAndPin('http://gpu-box.example.com:8000', {
          lookup: fakeLookup([{ address: '127.0.0.1', family: 4 }, { address, family: 6 }]),
        }));
        assert.equal(err.code, 'LOCAL_ADDRESS_PUBLIC', address);
        assert.equal(err.refused.length, 1, address);
      }
    });

    it('a loopback and a LAN answer are both kept, and the class is the wider one', async () => {
      const pinned = await resolveAndPin('http://workstation.example.com:11434', { lookup: fakeLookup(['127.0.0.1', '192.168.1.50']) });
      assert.deepEqual(pinned.addresses, ['127.0.0.1', '192.168.1.50']);
      assert.equal(pinned.class, 'lan');
      const widest = await resolveAndPin('http://workstation.example.com:11434', {
        lookup: fakeLookup(['100.64.0.5', '127.0.0.1', '10.0.0.2']), allowCgnat: true,
      });
      assert.equal(widest.class, 'cgnat');
    });

    it('answers are made canonical and a repeated answer is kept once', async () => {
      const pinned = await resolveAndPin('http://workstation.example.com:11434', {
        lookup: fakeLookup([{ address: '::ffff:192.168.1.50', family: 6 }, { address: '192.168.1.50', family: 4 }, { address: 'FD12:3456:0:0:0:0:0:1', family: 6 }]),
      });
      assert.deepEqual(pinned.addresses, ['192.168.1.50', 'fd12:3456::1']);
    });

    it('R-LI-29: refused without allowCgnat, allowed with it', async () => {
      const err = await rejection(resolveAndPin('http://100.64.0.5:8000', { lookup: noLookup }));
      assert.equal(err.code, 'LOCAL_ADDRESS_PUBLIC');
      assert.deepEqual(err.refused, [{ address: '100.64.0.5', class: 'cgnat' }]);
      const notTrue = await rejection(resolveAndPin('http://100.64.0.5:8000', { lookup: noLookup, allowCgnat: 'yes' }));
      assert.equal(notTrue.code, 'LOCAL_ADDRESS_PUBLIC');
      const pinned = await resolveAndPin('http://100.64.0.5:8000', { lookup: noLookup, allowCgnat: true });
      assert.deepEqual(pinned.addresses, ['100.64.0.5']);
      assert.equal(pinned.class, 'cgnat');
    });

    it('link-local, unspecified and public literals are refused with their class named', async () => {
      for (const [url, address, cls] of [
        ['http://169.254.169.254', '169.254.169.254', 'link-local'],
        ['http://[fe80::1]:8080', 'fe80::1', 'link-local'],
        ['http://0.0.0.0:11434', '0.0.0.0', 'unspecified'],
        ['http://[::]:11434', '::', 'unspecified'],
        ['http://198.51.100.7:11434', '198.51.100.7', 'public'],
        ['http://3325256711:11434', '198.51.100.7', 'public'],
        ['http://[::ffff:198.51.100.7]:11434', '198.51.100.7', 'public'],
        ['http://[2001:db8::1]:11434', '2001:db8::1', 'public'],
        ['http://[::7f00:1]:11434', '::7f00:1', 'public'],
      ]) {
        const err = await rejection(resolveAndPin(url, { lookup: noLookup, allowCgnat: true }));
        assert.equal(err.code, 'LOCAL_ADDRESS_PUBLIC', url);
        assert.deepEqual(err.refused, [{ address, class: cls }], url);
      }
    });

    it('no answer, a failed lookup or an answer that is not an address is refused', async () => {
      const empty = await rejection(resolveAndPin('http://gpu-box.example.com', { lookup: fakeLookup([]) }));
      assert.equal(empty.code, 'LOCAL_ADDRESS_UNRESOLVED');
      const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      const failed = await rejection(resolveAndPin('http://gpu-box.example.com', { lookup: async () => { throw cause; } }));
      assert.equal(failed.code, 'LOCAL_ADDRESS_UNRESOLVED');
      assert.equal(failed.cause, cause);
      for (const answers of [null, undefined, 'nope', {}, [null], [{ family: 4 }], [{ address: 'workstation' }], [{ address: '127.0.0.1' }, { address: 'not-an-ip' }], [42]]) {
        const err = await rejection(resolveAndPin('http://gpu-box.example.com', { lookup: fakeLookup(answers) }));
        assert.ok(err instanceof LocalAddressError, JSON.stringify(answers));
        assert.ok(['LOCAL_ADDRESS_UNRESOLVED', 'LOCAL_ADDRESS_PUBLIC'].includes(err.code), JSON.stringify(answers));
      }
    });

    it('a single address object (a lookup that ignored all: true) is read as one answer', async () => {
      const pinned = await resolveAndPin('http://workstation.example.com', { lookup: fakeLookup({ address: '127.0.0.1', family: 4 }) });
      assert.deepEqual(pinned.addresses, ['127.0.0.1']);
    });

    it('a bad URL is LOCAL_URL_INVALID before any lookup', async () => {
      const err = await rejection(resolveAndPin('http://user:pw@127.0.0.1', { lookup: noLookup }));
      assert.equal(err.code, 'LOCAL_URL_INVALID');
    });
  });

  describe('checkPinned', () => {
    it('accepts a stored pin whose addresses still classify as allowed', () => {
      assert.equal(checkPinned({ addresses: ['127.0.0.1'], class: 'loopback', at: 'x' }), true);
      assert.equal(checkPinned({ addresses: ['127.0.0.1', '192.168.1.50'], class: 'lan', at: 'x' }), true);
      assert.equal(checkPinned({ addresses: ['100.64.0.5'], class: 'cgnat', at: 'x' }, { allowCgnat: true }), true);
    });

    it('returns an error, never throws, for anything else', () => {
      const cases = [
        [{ addresses: ['203.0.113.9'], class: 'lan' }, {}],
        [{ addresses: ['127.0.0.1', '203.0.113.9'], class: 'loopback' }, {}],
        [{ addresses: ['100.64.0.5'], class: 'cgnat' }, {}],
        [{ addresses: ['169.254.169.254'], class: 'lan' }, {}],
        [{ addresses: ['192.168.1.50'], class: 'loopback' }, {}],
        [{ addresses: ['127.0.0.1'], class: 'public' }, {}],
        [{ addresses: ['127.0.0.1'] }, {}],
        [{ addresses: [], class: 'loopback' }, {}],
        [{ addresses: ['workstation'], class: 'loopback' }, {}],
        [{ addresses: '127.0.0.1', class: 'loopback' }, {}],
        [{ addresses: [null], class: 'loopback' }, {}],
        [{ class: 'loopback' }, {}],
        [null, {}],
        [undefined, {}],
        ['127.0.0.1', {}],
      ];
      for (const [pinned, options] of cases) {
        const result = checkPinned(pinned, options);
        assert.ok(result instanceof LocalAddressError, JSON.stringify(pinned));
        assert.ok(typeof result.code === 'string' && result.code.startsWith('LOCAL_'), JSON.stringify(pinned));
      }
      assert.equal(checkPinned({ addresses: ['203.0.113.9'], class: 'lan' }).code, 'LOCAL_ADDRESS_PUBLIC');
      assert.equal(checkPinned({ addresses: ['192.168.1.50'], class: 'loopback' }).code, 'LOCAL_PIN_INVALID');
      assert.ok(checkPinned() instanceof LocalAddressError);
    });
  });

  describe('gradeOf', () => {
    const loopback = { addresses: ['127.0.0.1'], class: 'loopback' };
    const lan = { addresses: ['192.168.1.50'], class: 'lan' };
    const cgnat = { addresses: ['100.64.0.5'], class: 'cgnat' };

    it('R-LI-30: gradeOf', () => {
      assert.equal(gradeOf({ pinned: loopback, protocol: 'http:', tlsFingerprint: null }), 'guarantee');
      assert.equal(gradeOf({ pinned: loopback, protocol: 'https:', tlsFingerprint: null }), 'guarantee');
      assert.equal(gradeOf({ pinned: lan, protocol: 'http:', tlsFingerprint: null }), 'cost-only');
      assert.equal(gradeOf({ pinned: lan, protocol: 'http:', tlsFingerprint: FP }), 'cost-only');
      assert.equal(gradeOf({ pinned: lan, protocol: 'https:', tlsFingerprint: null }), 'cost-only');
      assert.equal(gradeOf({ pinned: lan, protocol: 'https:', tlsFingerprint: FP }), 'guarantee');
      assert.equal(gradeOf({ pinned: lan, protocol: 'https:', tlsFingerprint: FP.toUpperCase() }), 'guarantee');
      assert.equal(gradeOf({ pinned: cgnat, protocol: 'http:', tlsFingerprint: null }), 'cost-only');
      assert.equal(gradeOf({ pinned: cgnat, protocol: 'https:', tlsFingerprint: null }), 'cost-only');
      assert.equal(gradeOf({ pinned: cgnat, protocol: 'https:', tlsFingerprint: FP }), 'guarantee');
    });

    it('R-LI-30: a fingerprint that is not 64 hex characters is no fingerprint', () => {
      for (const tlsFingerprint of ['', 'ab', FP.slice(1), `${FP}ab`, FP.replace('a', 'g'), FP.match(/../g).join(':'), true, 1, {}, undefined]) {
        assert.equal(gradeOf({ pinned: lan, protocol: 'https:', tlsFingerprint }), 'cost-only', String(tlsFingerprint));
      }
    });

    it('R-LI-30: the class is read from the addresses, never from the stored word', () => {
      assert.equal(gradeOf({ pinned: { addresses: ['192.168.1.50'], class: 'loopback' }, protocol: 'http:', tlsFingerprint: null }), 'cost-only');
      assert.equal(gradeOf({ pinned: { addresses: ['127.0.0.1', '192.168.1.50'], class: 'loopback' }, protocol: 'http:', tlsFingerprint: null }), 'cost-only');
      assert.equal(gradeOf({ pinned: { class: 'loopback' }, protocol: 'http:', tlsFingerprint: null }), 'cost-only');
      assert.equal(gradeOf({ pinned: { addresses: [], class: 'loopback' }, protocol: 'http:' }), 'cost-only');
      assert.equal(gradeOf({ pinned: { addresses: ['203.0.113.9'], class: 'loopback' }, protocol: 'https:', tlsFingerprint: FP }), 'cost-only');
      assert.equal(gradeOf({ pinned: { addresses: ['169.254.169.254'], class: 'lan' }, protocol: 'https:', tlsFingerprint: FP }), 'cost-only');
      assert.equal(gradeOf({ pinned: loopback, protocol: 'ftp:', tlsFingerprint: null }), 'cost-only');
      assert.equal(gradeOf({ pinned: null, protocol: 'http:' }), 'cost-only');
      assert.equal(gradeOf({}), 'cost-only');
      assert.equal(gradeOf(), 'cost-only');
    });
  });
});
