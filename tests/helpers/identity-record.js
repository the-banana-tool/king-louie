// What "an administrator ran `king-louie-service identity record`" leaves in
// a test's config dir (owner ruling R-F5-17), and how a test reads it back.
// Temp dirs are this user's: on Windows nobody owns them as Administrators
// and this process can write them, so the owner read is answered here (no
// PowerShell) and the service-side write probe is off. On POSIX a test
// passes its own uid as `adminUid`, as it does for node.yaml.
const R = require('../../src/service/identity-record');

const ADMINISTRATORS = 'S-1-5-32-544';
const owned = { owner: ADMINISTRATORS, link: false };
// What the service and doctor read of the access lists on Windows, answered
// in place too: what the installers and "identity record" leave (SYSTEM and
// Administrators in full, LOCAL SERVICE read and execute; Administrators as
// owner), for each path asked about: the record's directory and the record
// (the service), and the config dir before them (doctor).
const adminAcl = (flags) => ({ dacl: true, owner: ADMINISTRATORS, aces: [
  { type: 0, sid: 'S-1-5-18', mask: 0x1f01ff, flags }, { type: 0, sid: ADMINISTRATORS, mask: 0x1f01ff, flags }, { type: 0, sid: 'S-1-5-19', mask: 0x1200a9, flags }
] });
const IDENTITY_RECORD_TEST_OPTIONS = Object.freeze({
  serviceProbe: false,
  inspectOwners: () => ({ me: 'S-1-5-21-1-2-3-1001', entries: [owned, owned, owned] }),
  inspectAcl: (paths) => paths.map((p, i) => adminAcl(i < paths.length - 1 ? 3 : 0))
});

// identity: { nodeId, publicKey } with the key as DER hex or a Buffer.
function recordIdentity(configDir, identity) {
  return R.writeIdentityRecord({ configDir, nodeId: identity.nodeId, publicKey: identity.publicKey, runIcacls: () => {} });
}

module.exports = { recordIdentity, IDENTITY_RECORD_TEST_OPTIONS };
