// tests/e2e/models-roles.test.js
// Models M3 end to end (spec 2026-09-27 §7, §10, §11): a reply's metrics
// line splits its cost by role, and the King Louie proposal is accepted in
// the Models tab. The provider is Ollama pointed at a local fake server; the
// catalog overrides give its model the scores, tool calling and context the
// picking rules need. KL_TEST_MODE keeps fetches off.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor, readHistoryChats } = require('./helpers');
const { startFakeLlmServer } = require('../helpers/fake-llm-server');

const readData = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'chat-data.json'), 'utf8'));

// Polls the profile's data file from the test process.
async function waitUntil(fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fn()) return;
    } catch {
      // the file is being rewritten; read it again
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

describe('E2E: roles in use (models M3)', () => {
  let ctx;
  let server;

  before(async () => {
    server = await startFakeLlmServer();
    const now = new Date().toISOString();
    ctx = await launchApp({
      seed: {
        'chat-data.json': {
          onboardingComplete: true,
          activeChatId: 'chat-1',
          chats: [{ id: 'chat-1', title: 'Test chat', createdAt: now, updatedAt: now, messages: [] }],
          apiStatus: { ollama: { ok: true, message: 'Connected: 1 model.', checkedAt: now, models: ['test-model'] } },
          settings: {
            models: {
              ollama: { baseUrl: `${server.url}/ollama` },
              overrides: { 'ollama:test-model': { toolCall: true, limits: { context: 200000 }, scores: { intelligence: 50, agentic: 50 } } },
              profiles: [{ id: 'p-local', name: 'Local', kind: 'user', roles: { main: [{ provider: 'ollama', model: 'test-model', effort: null }], worker: [], utility: [] } }],
              defaultProfileId: 'p-local'
            }
          }
        }
      }
    });
    await waitFor(ctx, `!!document.getElementById('user-input')`);
  });

  after(async () => {
    if (ctx) await closeApp(ctx);
    if (server) await server.close();
  });

  it('a reply\'s metrics line splits its cost by role', async () => {
    await evaluate(ctx, `(() => {
      const input = document.getElementById('user-input');
      input.value = 'Say hello';
      input.dispatchEvent(new Event('input'));
      document.getElementById('send-btn').click();
      return true;
    })()`);
    await waitUntil(() => readHistoryChats(ctx)[0].messages.some((m) => m.sender === 'assistant' && m.llm && m.llm.byRole && m.llm.byRole.main));
    const text = await waitFor(ctx, `(() => {
      const els = [...document.querySelectorAll('.message-metrics-call')];
      const t = els.length ? els[els.length - 1].textContent : '';
      return t.includes(' · main $') ? t : null;
    })()`, 30000);
    assert.match(text, / · main \$/);
  });

  it('accepts the King Louie proposal in the Models tab', async () => {
    await evaluate(ctx, `document.getElementById('open-settings-btn').click(); true`);
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    await evaluate(ctx, `(() => { const s = document.getElementById('settings-nav-select'); s.value = 'models'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(ctx, `!!document.getElementById('models-kl-accept-btn')`, 15000);
    const roles = await evaluate(ctx, `[...document.querySelectorAll('.models-kl-change')].map((el) => el.dataset.role)`);
    assert.deepStrictEqual(roles, ['main', 'worker', 'utility']);
    await evaluate(ctx, `document.getElementById('models-kl-accept-btn').click(); true`);
    await waitUntil(() => readData(ctx).settings.models.profiles.some((p) => p.kind === 'king-louie'));
    const data = readData(ctx);
    const kl = data.settings.models.profiles.find((p) => p.kind === 'king-louie');
    assert.strictEqual(kl.name, 'King Louie selected');
    assert.deepStrictEqual(kl.roles.main, [{ provider: 'ollama', model: 'test-model', effort: null }]);
    assert.strictEqual(data.settings.models.defaultProfileId, 'p-local', 'accepting never changes the default');
    await waitFor(ctx, `document.getElementById('models-kl-status').textContent.includes('up to date')`, 15000);
    await waitFor(ctx, `[...document.querySelectorAll('#models-profile-list .models-profile-card')].some((c) => c.textContent.includes('King Louie selected'))`, 15000);
    // Local's worker is empty and borrows main; King Louie's has a model
    // (final review I1).
    const notices = await evaluate(ctx, `Object.fromEntries([...document.querySelectorAll('#models-profile-list .models-profile-card')].map((c) => [c.dataset.profileId, c.querySelector('.models-worker-borrow-notice')?.textContent || null]))`);
    assert.strictEqual(notices['p-local'], "Delegated reading runs on main's model until worker has one.");
    assert.strictEqual(Object.entries(notices).filter(([id]) => id !== 'p-local').every(([, n]) => n === null), true);
    assert.strictEqual(await evaluate(ctx, `!!document.querySelector('#models-kl-picks .models-worker-borrow-notice')`), false);
  });

  it('creates a custom role under Advanced and offers it in the profile editor', async () => {
    await evaluate(ctx, `(() => {
      const set = (id, value) => { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input')); };
      set('models-custom-role-id', 'legal-drafting');
      set('models-custom-role-description', 'Contracts and letters');
      document.getElementById('models-custom-role-fallback').value = 'main';
      document.getElementById('models-custom-role-tools').checked = true;
      document.getElementById('models-save-custom-role-btn').click();
      return true;
    })()`);
    await waitUntil(() => (readData(ctx).settings.models.customRoles || []).some((r) => r.id === 'legal-drafting'));
    const role = readData(ctx).settings.models.customRoles.find((r) => r.id === 'legal-drafting');
    assert.deepStrictEqual(role, { id: 'legal-drafting', description: 'Contracts and letters', needs: { toolCall: true }, fallback: 'main' });
    await waitFor(ctx, `document.getElementById('models-custom-role-list').textContent.includes('legal-drafting')`);
    await evaluate(ctx, `document.getElementById('models-new-profile-btn').click(); true`);
    await waitFor(ctx, `!!document.querySelector('.models-role-block[data-role="legal-drafting"]')`);
    await evaluate(ctx, `[...document.querySelectorAll('#models-profile-editor button')].find((b) => b.textContent === 'Cancel').click(); true`);
  });
});
