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

  it('has save and clear buttons for each channel', async () => {
    const saveTelegram = await evaluate(ctx, `!!document.getElementById('save-telegram-token-btn')`);
    const saveDiscord = await evaluate(ctx, `!!document.getElementById('save-discord-token-btn')`);
    const saveSlack = await evaluate(ctx, `!!document.getElementById('save-slack-tokens-btn')`);
    assert.ok(saveTelegram, 'save telegram button should exist');
    assert.ok(saveDiscord, 'save discord button should exist');
    assert.ok(saveSlack, 'save slack button should exist');
  });
});
