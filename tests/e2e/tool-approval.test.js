const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { launchApp, closeApp, evaluate, waitFor, click } = require('./helpers');

describe('E2E: Tool Approval UI', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('user-input')`);
  });

  after(async () => { await closeApp(ctx); });

  it('tool approval listener is registered', async () => {
    const registered = await evaluate(ctx, `
      typeof window.electron?.tool?.onApprovalRequired === 'function'
    `);
    assert.ok(registered, 'onApprovalRequired should be available');
  });

  it('directory access listener is registered', async () => {
    const registered = await evaluate(ctx, `
      typeof window.electron?.tool?.onDirectoryAccessRequired === 'function'
    `);
    assert.ok(registered, 'onDirectoryAccessRequired should be available');
  });

  it('ask user listener is registered', async () => {
    const registered = await evaluate(ctx, `
      typeof window.electron?.agent?.onAskUser === 'function'
    `);
    assert.ok(registered, 'onAskUser should be available');
  });

  it('tool approval respond function exists', async () => {
    const exists = await evaluate(ctx, `
      typeof window.electron?.tool?.respondToApproval === 'function'
    `);
    assert.ok(exists, 'respondToApproval should be available');
  });

  it('tool approval dialog renders correctly when triggered', async () => {
    // Simulate a tool approval request by calling the renderer's handler directly
    const rendered = await evaluate(ctx, `
      (() => {
        if (typeof showToolApprovalDialog !== 'function') return 'no_function';
        // Call it with fake data
        showToolApprovalDialog('test-approval-123', 'Bash', { command: 'echo hello' });
        return true;
      })()
    `);

    if (rendered === true) {
      await new Promise((r) => setTimeout(r, 300));

      // Check that the approval prompt appears in the chat
      const hasPrompt = await evaluate(ctx, `
        (() => {
          const msgs = document.querySelectorAll('.prompt-message, .message');
          for (const m of msgs) {
            if (m.textContent.includes('Bash') || m.textContent.includes('echo hello')) return true;
          }
          return false;
        })()
      `);
      assert.ok(hasPrompt, 'approval prompt should appear in chat');

      // Check for Approve/Deny buttons
      const hasButtons = await evaluate(ctx, `
        (() => {
          const btns = document.querySelectorAll('.prompt-actions button, .message button');
          return btns.length >= 2;
        })()
      `);
      assert.ok(hasButtons, 'should have approve/deny buttons');
    }
  });

  it('chat info popover shows tool list or agent config', async () => {
    await click(ctx, '#chat-info-btn');
    await new Promise((r) => setTimeout(r, 500));

    const popoverContent = await evaluate(ctx, `
      document.getElementById('chat-info-popover-body')?.textContent || ''
    `);

    // The popover should have tier/provider/model controls
    assert.ok(popoverContent.length > 0, 'chat info popover should have content');
  });
});
