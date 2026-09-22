const { describe, it } = require('node:test');
const assert = require('node:assert');
const { assertEnabledListenersBound } = require('../src/service/run');

// createCore treats a failed listener bind as non-fatal on purpose (it only
// log.warn's). In service mode that is a silent fail-open: an unprivileged
// local user can bind 127.0.0.1:<port> before boot, the service comes up
// reporting {"event":"ready"} with features.gateway on and no gateway, and
// ensureGatewayToken has still written a usable bearer token in the clear to
// <dataDir>/gateway-token. Neither `status` nor `doctor` looks at listeners.
const boundCore = () => ({ getGatewayServer: () => ({ wss: {} }), getWebhookServer: () => ({ httpServer: {} }) });
const unboundCore = () => ({ getGatewayServer: () => ({ wss: null }), getWebhookServer: () => ({ httpServer: null }) });

describe('assertEnabledListenersBound', () => {
  it('passes when nothing is enabled, whatever the listeners did', () => {
    const features = { gateway: false, webhooks: false };
    assertEnabledListenersBound(unboundCore(), features);
  });

  it('passes when every enabled listener bound', () => {
    assertEnabledListenersBound(boundCore(), { gateway: true, webhooks: true });
  });

  it('refuses when an enabled gateway did not bind', () => {
    assert.throws(
      () => assertEnabledListenersBound(unboundCore(), { gateway: true, webhooks: false }),
      /refusing to run without gateway.*could not bind/s
    );
  });

  it('refuses when an enabled webhook listener did not bind', () => {
    assert.throws(
      () => assertEnabledListenersBound(unboundCore(), { gateway: false, webhooks: true }),
      /refusing to run without webhooks/
    );
  });

  it('names both when both are enabled and neither bound', () => {
    assert.throws(
      () => assertEnabledListenersBound(unboundCore(), { gateway: true, webhooks: true }),
      /gateway and webhooks/
    );
  });

  it('tolerates a core that never constructed the servers', () => {
    const core = { getGatewayServer: () => undefined, getWebhookServer: () => undefined };
    assertEnabledListenersBound(core, { gateway: false, webhooks: false });
    assert.throws(() => assertEnabledListenersBound(core, { gateway: true, webhooks: false }), /refusing to run/);
  });
});
