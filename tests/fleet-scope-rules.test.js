// tests/fleet-scope-rules.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/fleet/scope-rules');
const { ScopeRegistry, createFleetScopeRegistry, SCOPE_RE: REGISTRY_SCOPE_RE } = require('../src/frontdoor/oauth/scopes');
const { scopeProblem } = require('../src/frontdoor/protocol/checks');
const messages = require('../src/frontdoor/protocol/messages');

describe('scope strings', () => {
  it('parses and formats <scope>[;machines=a,b]', () => {
    assert.deepEqual(S.parseScope('fleet:read'), { scope: 'fleet:read', machines: null });
    assert.deepEqual(S.parseScope('fleet:run;machines=gpu-box,web-01'), { scope: 'fleet:run', machines: ['gpu-box', 'web-01'] });
    assert.equal(S.formatScope({ scope: 'fleet:run', machines: ['gpu-box'] }), 'fleet:run;machines=gpu-box');
    assert.equal(S.formatScope({ scope: 'fleet:read', machines: null }), 'fleet:read');
  });

  it('refuses unsorted or duplicate machines and bad names', () => {
    for (const bad of ['fleet:run;machines=web-01,gpu-box', 'fleet:run;machines=a,a', 'FLEET:read', 'fleet:run;machines=', 'fleet:run;hosts=a']) {
      assert.throws(() => S.parseScope(bad), (err) => err.code === 'invalid_scope', bad);
    }
  });

  it('has no wildcard: *, fleet:* and friends are not scopes', () => {
    for (const bad of ['*', 'fleet:*', '*:read', 'fleet', 'fleet:run;machines=*', 'fleet:run;machines=Web-01', 'fleet:read\n', ' fleet:read', 'fleet:read;machines=web-01;machines=gpu-box', '']) {
      assert.throws(() => S.parseScope(bad), (err) => err.code === 'invalid_scope', JSON.stringify(bad));
    }
  });

  it('parses only real strings (no array or object coercion)', () => {
    for (const bad of [['fleet:read'], { toString: () => 'fleet:read' }, null, undefined, 1]) {
      assert.throws(() => S.parseScope(bad), (err) => err.code === 'invalid_scope');
    }
  });

  it('formatScope refuses an empty or malformed machines list instead of dropping it', () => {
    for (const bad of [{ scope: 'fleet:run', machines: [] }, { scope: 'fleet:run', machines: 'web-01' }, { scope: 'fleet:run' }]) {
      assert.throws(() => S.formatScope(bad), (err) => err.code === 'invalid_scope', JSON.stringify(bad));
    }
  });

  it('normalizeScopes accepts strings and exact objects', () => {
    assert.deepEqual(S.normalizeScopes(['fleet:read', { scope: 'fleet:run', machines: ['web-01'] }]), [
      { scope: 'fleet:read', machines: null },
      { scope: 'fleet:run', machines: ['web-01'] }
    ]);
    assert.deepEqual(S.normalizeScopes([]), []);
  });

  it('normalizeScopes never widens a malformed object', () => {
    const bad = [
      { scope: 'fleet:run', machines: [] }, // an empty list must not become "all machines"
      { scope: 'fleet:run' }, // a missing list must not become "all machines"
      { scope: 'fleet:run', machines: undefined },
      { scope: 'fleet:run', machines: ['web-01,gpu-box'] }, // one bad name must not become two good ones
      { scope: 'fleet:run', machines: ['web-01;x'] },
      { scope: 'fleet:run', machines: ['Web-01'] },
      { scope: 'fleet:run', machines: ['web-01', 'web-01'] },
      { scope: 'fleet:run;machines=web-01', machines: null }, // the limit rides in `machines`, not in `scope`
      { scope: 'fleet:*', machines: null },
      null,
      'garbage;;'
    ];
    for (const entry of bad) {
      assert.throws(() => S.normalizeScopes([entry]), (err) => err.code === 'invalid_scope', JSON.stringify(entry));
    }
    assert.throws(() => S.normalizeScopes('fleet:read'), (err) => err.code === 'invalid_scope');
  });

  it('normalizeScopes refuses the same scope twice (no order-dependent widening)', () => {
    assert.throws(() => S.normalizeScopes(['fleet:run;machines=web-01', 'fleet:run']), (err) => err.code === 'invalid_scope');
    assert.throws(() => S.normalizeScopes(['fleet:run', 'fleet:run;machines=web-01']), (err) => err.code === 'invalid_scope');
  });
});

describe('scope-rules stays pure', () => {
  it('requires nothing (the runbook profile loads it)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/fleet/scope-rules.js'), 'utf8');
    assert.equal(/\brequire\s*\(/.test(src), false);
    assert.equal(/\bimport\b/.test(src), false);
  });

  it('its copied regex literals equal Task 1 SCOPE_RE and MACHINE_NAME_RE', () => {
    assert.equal(S.SCOPE_NAME_RE.source, messages.SCOPE_RE.source);
    assert.equal(S.SCOPE_NAME_RE.flags, messages.SCOPE_RE.flags);
    assert.equal(S.MACHINE_NAME_RE.source, messages.MACHINE_NAME_RE.source);
    assert.equal(S.MACHINE_NAME_RE.flags, messages.MACHINE_NAME_RE.flags);
    assert.equal(REGISTRY_SCOPE_RE.source, messages.SCOPE_RE.source);
    assert.equal(REGISTRY_SCOPE_RE.flags, messages.SCOPE_RE.flags);
  });

  it('REQUIRED_SCOPE is frozen and covers the nine fleet tools', () => {
    assert.ok(Object.isFrozen(S.REQUIRED_SCOPE));
    assert.deepEqual({ ...S.REQUIRED_SCOPE }, {
      list_machines: 'fleet:read',
      describe_machine: 'fleet:read',
      get_state: 'fleet:read',
      get_job: 'fleet:read',
      get_job_logs: 'fleet:read',
      run_runbook: 'fleet:run',
      cancel_job: 'fleet:run',
      delegate: 'fleet:delegate',
      send_to_job: 'fleet:delegate'
    });
  });
});

describe('allows', () => {
  const scopes = ['fleet:read', 'fleet:run;machines=web-01'];

  it('needs the tool scope, and the machine inside machines=', () => {
    assert.deepEqual(S.allows(scopes, 'get_state', { machine: 'gpu-box' }), { ok: true });
    assert.deepEqual(S.allows(scopes, 'run_runbook', { machine: 'web-01', tier: 'routine' }), { ok: true });
    assert.deepEqual(S.allows(scopes, 'run_runbook', { machine: 'gpu-box', tier: 'routine' }), { ok: false, code: 'unknown_machine', required: 'fleet:run' });
    assert.deepEqual(S.allows(scopes, 'delegate', { machine: 'web-01' }), { ok: false, code: 'insufficient_scope', required: 'fleet:delegate' });
  });

  it('every fleet tool: allowed with its scope, refused without it', () => {
    for (const [tool, scope] of Object.entries(S.REQUIRED_SCOPE)) {
      assert.deepEqual(S.allows([scope], tool, { machine: 'web-01' }), { ok: true }, tool);
      const others = ['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate'].filter((s) => s !== scope);
      assert.deepEqual(S.allows(others, tool, { machine: 'web-01' }), { ok: false, code: 'insufficient_scope', required: scope }, tool);
    }
  });

  it('machines= matches exact, case-sensitive names only', () => {
    const limited = ['fleet:run;machines=gpu-box,web-01'];
    assert.equal(S.allows(limited, 'cancel_job', { machine: 'gpu-box' }).ok, true);
    assert.equal(S.allows(limited, 'cancel_job', { machine: 'web-01' }).ok, true);
    for (const other of ['Web-01', 'WEB-01', 'web-0', 'web-01 ', 'web-011', 'gpu-box,web-01', 'web', '']) {
      assert.deepEqual(S.allows(limited, 'cancel_job', { machine: other }), { ok: false, code: 'unknown_machine', required: 'fleet:run' }, JSON.stringify(other));
    }
  });

  it('an unrestricted entry covers any real machine name, including capitals (Deviation 18)', () => {
    assert.equal(S.allows(['fleet:run'], 'cancel_job', { machine: 'web-01' }).ok, true);
    assert.equal(S.allows(['fleet:run'], 'cancel_job', { machine: 'Build-Box' }).ok, true);
  });

  it('a supplied machine that is not a name matches nothing, even unrestricted', () => {
    for (const machine of ['', undefined, 0, ['web-01'], { name: 'web-01' }, true]) {
      assert.deepEqual(S.allows(['fleet:run'], 'cancel_job', { machine }), { ok: false, code: 'unknown_machine', required: 'fleet:run' }, String(machine));
      assert.deepEqual(S.allows(['fleet:run;machines=web-01'], 'cancel_job', { machine }), { ok: false, code: 'unknown_machine', required: 'fleet:run' }, String(machine));
    }
  });

  it('machine: null (or none) is the scope-only check', () => {
    assert.deepEqual(S.allows(['fleet:run;machines=web-01'], 'run_runbook'), { ok: true });
    assert.deepEqual(S.allows(['fleet:run;machines=web-01'], 'run_runbook', { machine: null }), { ok: true });
    assert.deepEqual(S.allows(['fleet:read'], 'run_runbook'), { ok: false, code: 'insufficient_scope', required: 'fleet:run' });
  });

  it('a grant naming a machine that does not exist grants nothing elsewhere', () => {
    const ghost = ['fleet:read;machines=ghost', 'fleet:run;machines=ghost'];
    assert.equal(S.allows(ghost, 'run_runbook', { machine: 'web-01', tier: 'read' }).ok, false);
    assert.equal(S.allows(ghost, 'get_state', { machine: 'gpu-box' }).ok, false);
    assert.equal(S.machineVisible(ghost, 'web-01'), false);
  });

  it('an unsafe runbook also needs fleet:unsafe covering the machine', () => {
    assert.deepEqual(S.allows(scopes, 'run_runbook', { machine: 'web-01', tier: 'unsafe' }), { ok: false, code: 'insufficient_scope', required: 'fleet:unsafe' });
    const withUnsafe = [...scopes, 'fleet:unsafe;machines=web-01'];
    assert.deepEqual(S.allows(withUnsafe, 'run_runbook', { machine: 'web-01', tier: 'unsafe' }), { ok: true });
  });

  it('fleet:unsafe cannot escalate: it needs fleet:run on the same machine, and its own machines=', () => {
    // fleet:unsafe alone runs nothing, not even a read runbook
    for (const tier of ['read', 'routine', 'unsafe', null]) {
      assert.deepEqual(S.allows(['fleet:unsafe'], 'run_runbook', { machine: 'web-01', tier }), { ok: false, code: 'insufficient_scope', required: 'fleet:run' }, String(tier));
    }
    // with fleet:delegate (valid at grant time) it still runs no runbook
    assert.equal(S.allows(['fleet:delegate', 'fleet:unsafe'], 'run_runbook', { machine: 'web-01', tier: 'unsafe' }).ok, false);
    // fleet:unsafe stands in for no other scope
    for (const tool of Object.keys(S.REQUIRED_SCOPE)) {
      assert.equal(S.allows(['fleet:unsafe'], tool, { machine: 'web-01' }).ok, false, tool);
    }
    // unrestricted unsafe does not widen a limited fleet:run
    assert.deepEqual(S.allows(['fleet:run;machines=web-01', 'fleet:unsafe'], 'run_runbook', { machine: 'gpu-box', tier: 'unsafe' }), { ok: false, code: 'unknown_machine', required: 'fleet:run' });
    // unrestricted run does not widen a limited fleet:unsafe
    assert.deepEqual(S.allows(['fleet:run', 'fleet:unsafe;machines=web-01'], 'run_runbook', { machine: 'gpu-box', tier: 'unsafe' }), { ok: false, code: 'insufficient_scope', required: 'fleet:unsafe' });
    assert.deepEqual(S.allows(['fleet:run', 'fleet:unsafe;machines=web-01'], 'run_runbook', { machine: 'gpu-box', tier: 'routine' }), { ok: true });
    assert.deepEqual(S.allows(['fleet:run', 'fleet:unsafe;machines=web-01'], 'run_runbook', { machine: 'web-01', tier: 'unsafe' }), { ok: true });
  });

  it('read and routine tiers need only fleet:run; any other tier is treated as unsafe', () => {
    assert.deepEqual(S.allows(['fleet:run'], 'run_runbook', { machine: 'web-01', tier: 'read' }), { ok: true });
    assert.deepEqual(S.allows(['fleet:run'], 'run_runbook', { machine: 'web-01', tier: 'routine' }), { ok: true });
    assert.deepEqual(S.allows(['fleet:run'], 'run_runbook', { machine: 'web-01', tier: null }), { ok: true });
    for (const tier of ['unsafe', 'Unsafe', 'denied', 'bogus', '', 0]) {
      assert.deepEqual(S.allows(['fleet:run'], 'run_runbook', { machine: 'web-01', tier }), { ok: false, code: 'insufficient_scope', required: 'fleet:unsafe' }, String(tier));
      assert.deepEqual(S.allows(['fleet:run', 'fleet:unsafe'], 'run_runbook', { machine: 'web-01', tier }), { ok: true }, String(tier));
    }
  });

  it('a malformed scope list allows nothing', () => {
    assert.equal(S.allows(['fleet:read', 'garbage;;'], 'get_state').ok, false);
    assert.equal(S.allows(null, 'get_state').ok, false);
    assert.equal(S.allows('fleet:read', 'get_state').ok, false);
    assert.equal(S.allows(['fleet:read', 'fleet:read'], 'get_state').ok, false);
    assert.equal(S.allows([{ scope: 'fleet:run', machines: [] }], 'run_runbook', { machine: 'web-01' }).ok, false);
  });

  it('unknown scopes grant nothing', () => {
    const unknown = ['cases:read', 'fleet:admin', 'fleet:write', 'admin:all'];
    for (const tool of Object.keys(S.REQUIRED_SCOPE)) {
      assert.equal(S.allows(unknown, tool, { machine: 'web-01' }).ok, false, tool);
    }
    assert.equal(S.hasScope(unknown, 'fleet:unsafe'), false);
    assert.equal(S.machineVisible(unknown, 'web-01'), false);
  });

  it('an unknown tool needs an explicit required scope', () => {
    assert.equal(S.allows(['cases:read'], 'list_cases').ok, false);
    assert.equal(S.allows(['cases:read'], 'toString').ok, false);
    assert.deepEqual(S.allows(['cases:read'], 'list_cases', { required: 'cases:read' }), { ok: true });
    assert.deepEqual(S.allows(['cases:read;machines=web-01'], 'list_cases', { required: 'cases:read', machine: 'web-01' }), { ok: true });
    assert.deepEqual(S.allows(['cases:read;machines=web-01'], 'list_cases', { required: 'cases:read', machine: 'gpu-box' }), { ok: false, code: 'unknown_machine', required: 'cases:read' });
    assert.deepEqual(S.allows(['cases:read'], 'list_cases', { required: 'cases:write' }), { ok: false, code: 'insufficient_scope', required: 'cases:write' });
  });

  it('`required` never lowers a fleet tool below its own scope', () => {
    assert.deepEqual(S.allows(['fleet:read'], 'run_runbook', { required: 'fleet:read', machine: 'web-01' }), { ok: false, code: 'insufficient_scope', required: 'fleet:run' });
    assert.deepEqual(S.allows(['fleet:run'], 'run_runbook', { required: 'fleet:run', machine: 'web-01' }), { ok: true });
  });

  it('a malformed `required` allows nothing', () => {
    for (const required of ['*', 'fleet:*', 'CASES:read', ['cases:read'], 1]) {
      assert.equal(S.allows(['cases:read'], 'list_cases', { required }).ok, false, JSON.stringify(required));
    }
  });

  it('machineVisible follows the fleet:read entry', () => {
    assert.equal(S.machineVisible(['fleet:read;machines=web-01'], 'web-01'), true);
    assert.equal(S.machineVisible(['fleet:read;machines=web-01'], 'gpu-box'), false);
    assert.equal(S.machineVisible(['fleet:run'], 'gpu-box'), false);
    assert.equal(S.machineVisible(['fleet:read'], 'gpu-box'), true);
    assert.equal(S.machineVisible(['fleet:read;machines=web-01'], 'Web-01'), false);
    assert.equal(S.machineVisible(['fleet:read'], ''), false);
    assert.equal(S.machineVisible(['fleet:read'], null), false);
    assert.equal(S.machineVisible(['fleet:read'], undefined), false);
    assert.equal(S.machineVisible(['fleet:read', 'garbage;;'], 'web-01'), false);
    assert.equal(S.machineVisible(null, 'web-01'), false);
  });

  it('an inherited machine is honoured like an own one', () => {
    const opts = Object.create({ machine: 'gpu-box' });
    assert.deepEqual(S.allows(['fleet:run;machines=web-01'], 'cancel_job', opts), { ok: false, code: 'unknown_machine', required: 'fleet:run' });
    const undef = Object.create({ machine: undefined });
    assert.deepEqual(S.allows(['fleet:run'], 'cancel_job', undef), { ok: false, code: 'unknown_machine', required: 'fleet:run' });
    assert.deepEqual(S.allows(['fleet:run;machines=web-01'], 'cancel_job', Object.create({ machine: 'web-01' })), { ok: true });
  });

  it('covers: the named scope is present and its machine list covers the machine', () => {
    // an unlimited scope
    assert.equal(S.covers(['fleet:run', 'fleet:unsafe'], 'fleet:unsafe', 'gpu-box'), true);
    assert.equal(S.covers(['fleet:unsafe'], 'fleet:unsafe', 'Build-Box'), true);
    // a limited scope that covers the machine
    assert.equal(S.covers(['fleet:unsafe;machines=gpu-box,web-01'], 'fleet:unsafe', 'web-01'), true);
    // a limited scope that does not
    assert.equal(S.covers(['fleet:unsafe;machines=web-01'], 'fleet:unsafe', 'gpu-box'), false);
    assert.equal(S.covers(['fleet:unsafe;machines=web-01'], 'fleet:unsafe', 'Web-01'), false);
    // a missing scope
    assert.equal(S.covers(['fleet:run'], 'fleet:unsafe', 'web-01'), false);
    assert.equal(S.covers([], 'fleet:unsafe', 'web-01'), false);
    // not a machine name, or a malformed list: nothing
    for (const machine of ['', null, undefined, ['web-01']]) assert.equal(S.covers(['fleet:unsafe'], 'fleet:unsafe', machine), false, String(machine));
    assert.equal(S.covers(['fleet:unsafe', 'garbage;;'], 'fleet:unsafe', 'web-01'), false);
    assert.equal(S.covers(null, 'fleet:unsafe', 'web-01'), false);
  });

  it('hasScope finds a scope by exact name, limited or not', () => {
    assert.equal(S.hasScope(['fleet:run', 'fleet:unsafe;machines=web-01'], 'fleet:unsafe'), true);
    assert.equal(S.hasScope(['fleet:run'], 'fleet:unsafe'), false);
    assert.equal(S.hasScope(['fleet:run'], 'fleet:Run'), false);
    assert.equal(S.hasScope(['fleet:unsafe', 'garbage;;'], 'fleet:unsafe'), false);
    assert.equal(S.hasScope(null, 'fleet:unsafe'), false);
    assert.equal(S.hasScope(undefined, 'fleet:unsafe'), false);
  });
});

describe('ScopeRegistry', () => {
  it('advertises only registered and enabled scopes', () => {
    const r = createFleetScopeRegistry();
    assert.deepEqual(r.supported(['fleet:read', 'fleet:run', 'cases:read']), ['fleet:read', 'fleet:run']);
    r.register('cases:read', { tools: ['list_cases'], description: 'Read cases' });
    assert.deepEqual(r.supported(['fleet:read', 'cases:read']), ['cases:read', 'fleet:read']);
    assert.equal(r.requiredScopeFor('list_cases'), 'cases:read');
    assert.equal(r.requiredScopeFor('delegate'), 'fleet:delegate');
    assert.throws(() => r.register('cases:read', { tools: [] }), /already registered/);
  });

  it('registered but not enabled is not supported; nothing is supported by default', () => {
    const r = createFleetScopeRegistry();
    assert.deepEqual(r.supported([]), []);
    assert.deepEqual(r.supported(null), []);
    assert.deepEqual(r.supported(undefined), []);
    assert.deepEqual(r.supported(['*', 'fleet:*']), []);
    assert.deepEqual(r.names(), ['fleet:delegate', 'fleet:read', 'fleet:run', 'fleet:unsafe']);
    assert.equal(r.has('fleet:read'), true);
    assert.equal(r.has('cases:read'), false);
    assert.equal(r.get('cases:read'), null);
    assert.deepEqual(r.get('fleet:unsafe').requires, ['fleet:run', 'fleet:delegate']);
    assert.ok(Object.isFrozen(r.get('fleet:unsafe')));
  });

  it('rules() feeds the grant check: fleet:unsafe needs fleet:run or fleet:delegate', () => {
    const rules = createFleetScopeRegistry().rules(['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate']);
    assert.equal(scopeProblem(['fleet:read', 'fleet:unsafe'], rules), 'invalid_scope');
    assert.equal(scopeProblem(['fleet:delegate', 'fleet:unsafe'], rules), null);
    assert.equal(scopeProblem(['fleet:run', 'fleet:unsafe'], rules), null);
    assert.equal(scopeProblem(['fleet:unsafe'], rules), 'invalid_scope');
    assert.equal(scopeProblem(['fleet:read'], createFleetScopeRegistry().rules(['fleet:run'])), 'invalid_scope');
    assert.equal(scopeProblem(['cases:read'], rules), 'invalid_scope');
    assert.equal(scopeProblem(['fleet:*'], rules), 'invalid_scope');
  });

  it('rules() returns copies the caller cannot use to change the registry', () => {
    const r = createFleetScopeRegistry();
    const rules = r.rules(['fleet:run', 'fleet:unsafe']);
    rules.requires['fleet:unsafe'].push('fleet:read');
    rules.supported.push('fleet:read');
    assert.deepEqual(r.rules(['fleet:run', 'fleet:unsafe']), { supported: ['fleet:run', 'fleet:unsafe'], requires: { 'fleet:unsafe': ['fleet:run', 'fleet:delegate'] } });
  });

  it('toolsFor lists what a token may see', () => {
    const r = createFleetScopeRegistry();
    assert.deepEqual([...r.toolsFor(['fleet:read'])].sort(), ['describe_machine', 'get_job', 'get_job_logs', 'get_state', 'list_machines']);
    assert.ok(r.toolsFor(['fleet:run']).has('run_runbook'));
  });

  it('toolsFor: fleet:unsafe and unknown scopes add no tools', () => {
    const r = createFleetScopeRegistry();
    assert.deepEqual([...r.toolsFor(['fleet:unsafe'])], []);
    assert.deepEqual([...r.toolsFor(['cases:read', 'fleet:*', '*'])], []);
    assert.deepEqual([...r.toolsFor(null)], []);
    assert.deepEqual([...r.toolsFor(['fleet:delegate'])].sort(), ['delegate', 'send_to_job']);
  });

  it('requiredScopeFor: fleet tools keep their scope, unknown tools have none', () => {
    const r = createFleetScopeRegistry();
    for (const [tool, scope] of Object.entries(S.REQUIRED_SCOPE)) assert.equal(r.requiredScopeFor(tool), scope, tool);
    assert.equal(r.requiredScopeFor('list_cases'), null);
    assert.equal(r.requiredScopeFor('toString'), null);
    assert.equal(r.requiredScopeFor('__proto__'), null);
  });

  it('a later scope cannot claim a fleet tool or a tool another scope owns', () => {
    const r = createFleetScopeRegistry();
    assert.throws(() => r.register('cases:read', { tools: ['run_runbook'] }), /run_runbook/);
    assert.throws(() => r.register('cases:read', { tools: ['list_machines'] }), /list_machines/);
    assert.equal(r.has('cases:read'), false);
    r.register('cases:read', { tools: ['list_cases'] });
    assert.throws(() => r.register('cases:write', { tools: ['list_cases'] }), /list_cases/);
    assert.equal(r.has('cases:write'), false);
    assert.deepEqual([...r.toolsFor(['cases:read'])], ['list_cases']);
  });

  it('the fleet: namespace is registered only by createFleetScopeRegistry', () => {
    const r = new ScopeRegistry();
    for (const name of ['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate', 'fleet:admin']) {
      assert.throws(() => r.register(name, { tools: [] }), /fleet: namespace/, name);
    }
    assert.deepEqual(r.names(), []);
    assert.throws(() => createFleetScopeRegistry().register('fleet:admin', { tools: [] }), /fleet: namespace/);
    // createFleetScopeRegistry leaves the namespace closed behind it
    createFleetScopeRegistry();
    assert.throws(() => new ScopeRegistry().register('fleet:unsafe', { tools: [] }), /fleet: namespace/);
  });

  it('fleet:unsafe keeps its rule: it cannot be dropped or replaced', () => {
    const r = createFleetScopeRegistry();
    assert.throws(() => r.register('fleet:unsafe', { tools: ['run_runbook'], requires: null }));
    assert.throws(() => r.register('fleet:unsafe', { tools: ['run_runbook'], requires: ['fleet:read'] }));
    const entry = r.get('fleet:unsafe');
    assert.throws(() => entry.requires.push('fleet:read'), TypeError);
    try { entry.requires = null; } catch { /* strict mode throws; sloppy mode ignores */ }
    assert.deepEqual(r.get('fleet:unsafe').requires, ['fleet:run', 'fleet:delegate']);
    assert.equal(r.scopes, undefined, 'the scope map is private');
    r.scopes = new Map();
    assert.deepEqual(r.rules(['fleet:run', 'fleet:unsafe']).requires, { 'fleet:unsafe': ['fleet:run', 'fleet:delegate'] });
    assert.equal(scopeProblem(['fleet:read', 'fleet:unsafe'], r.rules(['fleet:read', 'fleet:unsafe'])), 'invalid_scope');
  });

  it('refuses a malformed scope name', () => {
    assert.throws(() => new ScopeRegistry().register('Fleet', { tools: [] }), /scope name/);
    for (const name of ['*', 'fleet:*', 'fleet:read;machines=web-01', ' fleet:read', 42, null]) {
      assert.throws(() => new ScopeRegistry().register(name, { tools: [] }), /scope name/, String(name));
    }
  });

  it('refuses malformed tools or requires', () => {
    assert.throws(() => new ScopeRegistry().register('cases:read', {}), /tools/);
    assert.throws(() => new ScopeRegistry().register('cases:read', { tools: 'list_cases' }), /tools/);
    assert.throws(() => new ScopeRegistry().register('cases:read', { tools: [1] }), /tools/);
    assert.throws(() => new ScopeRegistry().register('cases:read', { tools: [], requires: 'cases:write' }), /requires/);
    assert.throws(() => new ScopeRegistry().register('cases:read', { tools: [], requires: ['*'] }), /requires/);
    assert.throws(() => new ScopeRegistry().register('cases:read', { tools: [], requires: [] }), /requires/);
  });
});
