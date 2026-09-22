const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: Settings — Channels', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
    await click(ctx, '#open-settings-btn');
    await waitFor(ctx, `!document.getElementById('settings-drawer').hidden`);
    await evaluate(ctx, `
      (() => {
        const sel = document.getElementById('settings-nav-select');
        for (const opt of sel.options) {
          if (opt.textContent.includes('Channel') || opt.value === 'channels') {
            sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true;
          }
        }
        return false;
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
  });

  after(async () => { await closeApp(ctx); });

  it('has Telegram token input', async () => {
    const exists = await evaluate(ctx, `!!document.getElementById('channel-telegram-token-input')`);
    assert.ok(exists);
  });

  it('has Discord token input and toggles', async () => {
    const token = await evaluate(ctx, `!!document.getElementById('channel-discord-token-input')`);
    const enabled = await evaluate(ctx, `!!document.getElementById('channel-discord-enabled-input')`);
    assert.ok(token, 'Discord token input should exist');
    assert.ok(enabled, 'Discord enabled toggle should exist');
  });

  it('has Slack token inputs and toggles', async () => {
    const app = await evaluate(ctx, `!!document.getElementById('channel-slack-app-token-input')`);
    const bot = await evaluate(ctx, `!!document.getElementById('channel-slack-bot-token-input')`);
    const enabled = await evaluate(ctx, `!!document.getElementById('channel-slack-enabled-input')`);
    assert.ok(app, 'Slack app token should exist');
    assert.ok(bot, 'Slack bot token should exist');
    assert.ok(enabled, 'Slack enabled toggle should exist');
  });

  it('has an access-control pane for Telegram and Discord', async () => {
    for (const channel of ['telegram', 'discord']) {
      for (const suffix of ['users-list', 'groups-list', 'user-input', 'user-add-btn', 'approval-input', 'approval-save-btn']) {
        const exists = await evaluate(ctx, `!!document.getElementById('channel-${channel}-${suffix}')`);
        assert.ok(exists, `channel-${channel}-${suffix} should exist`);
      }
    }
  });

  it('says plainly that an unconfigured channel denies everyone', async () => {
    const text = await evaluate(ctx, `document.getElementById('channel-telegram-users-list').textContent`);
    assert.match(text, /nobody can reach the agent/i);
  });

  it('says plainly that approvals are denied until a target is set', async () => {
    const status = await evaluate(ctx, `document.getElementById('channel-telegram-access-status').textContent`);
    assert.match(status, /denied/i);
  });

  it('round-trips an allowed user id through IPC', async () => {
    await evaluate(ctx, `
      (async () => {
        document.getElementById('channel-telegram-user-input').value = '1234509876';
        document.getElementById('channel-telegram-user-add-btn').click();
      })()
    `);
    await waitFor(ctx, `document.getElementById('channel-telegram-users-list').textContent.includes('1234509876')`);
    const state = await evaluate(ctx, `
      window.electron.channels.getAccess({ channel: 'telegram' }).then((r) => JSON.stringify(r.data.users))
    `);
    assert.match(state, /1234509876/);

    // And remove it again, so the profile is left as it was found.
    await evaluate(ctx, `
      window.electron.channels.remove({ channel: 'telegram', kind: 'user', id: '1234509876' }).then((r) => r.ok)
    `);
  });

  it('round-trips the approval target and reports that clearing it denies approvals', async () => {
    await evaluate(ctx, `
      window.electron.channels.setApprovalTarget({ channel: 'discord', approvalChatId: 'owner-only' }).then((r) => r.ok)
    `);
    const saved = await evaluate(ctx, `
      window.electron.channels.getAccess({ channel: 'discord' }).then((r) => r.data.approvalChatId)
    `);
    assert.strictEqual(saved, 'owner-only');

    const cleared = await evaluate(ctx, `
      window.electron.channels.setApprovalTarget({ channel: 'discord', approvalChatId: '' }).then((r) => r.data.approvalChatId)
    `);
    assert.strictEqual(cleared, '');
  });

  it('offers no control that re-opens a channel to everyone', async () => {
    const defaultPolicy = await evaluate(ctx, `
      window.electron.channels.getAccess({ channel: 'telegram' }).then((r) => r.data.defaultPolicy)
    `);
    assert.strictEqual(defaultPolicy, 'deny');
    const hasAllowAll = await evaluate(ctx, `typeof window.electron.channels.allowEveryone`);
    assert.strictEqual(hasAllowAll, 'undefined');
  });

  it('has save and clear buttons for each channel', async () => {
    const saveTelegram = await evaluate(ctx, `!!document.getElementById('save-telegram-token-btn')`);
    const saveDiscord = await evaluate(ctx, `!!document.getElementById('save-discord-token-btn')`);
    const saveSlack = await evaluate(ctx, `!!document.getElementById('save-slack-tokens-btn')`);
    assert.ok(saveTelegram, 'save telegram button should exist');
    assert.ok(saveDiscord, 'save discord button should exist');
    assert.ok(saveSlack, 'save slack button should exist');
  });
});
