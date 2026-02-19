const {
  splitMessage,
  formatHelp,
  formatStatus,
  formatApprovalRequest
} = require('./telegram-adapter');
const { skillRegistry } = require('../skills');

class TelegramBridge {
  constructor(options = {}) {
    this.token = options.token;
    this.gateway = options.gatewayServer;
    this.sessionManager = options.sessionManager;
    this.getAgent = options.getAgent || (() => null);
    this.listAgents = options.listAgents || (() => []);
    this.pinManager = options.pinManager || null;
    this.pollTimeoutSeconds = Number(options.pollTimeoutSeconds || 30);

    // Callbacks for local chat management
    this.createLocalChat = options.createLocalChat || (() => null);
    this.addMessageToLocalChat = options.addMessageToLocalChat || (() => {});

    this.apiBase = `https://api.telegram.org/bot${this.token}`;
    this.offset = 0;
    this.running = false;
    this.pollAbortController = null;

    this.chatState = new Map();
    this.pendingRuns = new Map();
    this.pendingApprovals = new Map();
    this.telegramToLocalChatMap = new Map(); // Maps Telegram chat ID to local King Louie chat ID

    this.boundAgentResponse = this.handleAgentResponse.bind(this);
  }

  async start() {
    if (this.running) return;
    if (!this.token) {
      throw new Error('Telegram bridge requires a bot token');
    }

    this.running = true;
    this.gateway.on('agent:response', this.boundAgentResponse);
    this.pollLoop().catch((error) => {
      console.error('[telegram-bridge] polling failed:', error.message);
    });
  }

  async stop() {
    if (!this.running) return;

    this.running = false;
    this.gateway.off('agent:response', this.boundAgentResponse);

    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }

    for (const approval of this.pendingApprovals.values()) {
      approval.resolve(false);
      clearTimeout(approval.timer);
    }
    this.pendingApprovals.clear();
  }

  async pollLoop() {
    while (this.running) {
      try {
        this.pollAbortController = new AbortController();
        const updates = await this.getUpdates(this.pollAbortController.signal);
        this.pollAbortController = null;

        for (const update of updates) {
          this.offset = Math.max(this.offset, Number(update.update_id || 0) + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running) break;

        const aborted = error?.name === 'AbortError';
        if (!aborted) {
          console.error('[telegram-bridge] update handling error:', error.message);
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      }
    }
  }

  async getUpdates(signal) {
    const response = await this.callTelegram('getUpdates', {
      offset: this.offset,
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ['message', 'callback_query']
    }, { signal });

    return Array.isArray(response) ? response : [];
  }

  async handleUpdate(update = {}) {
    if (update.message) {
      await this.handleMessage(update.message);
      return;
    }

    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  getOrCreateChatState(chatId) {
    const key = String(chatId);
    if (!this.chatState.has(key)) {
      const agentId = 'main';
      this.chatState.set(key, {
        chatId: key,
        agentId,
        sessionKey: this.sessionManager.buildSessionKey(agentId, 'telegram', key)
      });
    }

    return this.chatState.get(key);
  }

  getOrCreateLocalChat(telegramChatId, userName = 'Unknown') {
    const key = String(telegramChatId);

    // Check if we already have a local chat for this Telegram chat
    if (this.telegramToLocalChatMap.has(key)) {
      return this.telegramToLocalChatMap.get(key);
    }

    // Create a new local chat
    const chatTitle = `📱 Telegram: ${userName} (${telegramChatId})`;
    const localChatId = this.createLocalChat(chatTitle);

    if (localChatId) {
      this.telegramToLocalChatMap.set(key, localChatId);
    }

    return localChatId;
  }

  addToLocalChat(telegramChatId, sender, text) {
    const localChatId = this.telegramToLocalChatMap.get(String(telegramChatId));
    if (localChatId) {
      this.addMessageToLocalChat(localChatId, sender, text);
    }
  }

  async handleMessage(message = {}) {
    const chatId = String(message?.chat?.id || '');
    const text = String(message.text || '').trim();
    if (!chatId) return;

    // Get user info for chat title
    const userName = message?.from?.username || message?.from?.first_name || 'User';

    // Create or get local chat for audit logging
    this.getOrCreateLocalChat(chatId, userName);

    if (text.startsWith('/')) {
      await this.handleCommand(chatId, text);
      return;
    }

    if (!text) {
      await this.sendMessage(chatId, 'Send text or use /help for available commands.');
      return;
    }

    // Add user message to local chat
    this.addToLocalChat(chatId, 'user', text);

    const state = this.getOrCreateChatState(chatId);
    const pinnedSkillId = this.pinManager?.getPinned(state.sessionKey);
    if (pinnedSkillId) {
      const skill = skillRegistry.getSkill(pinnedSkillId);
      if (skill && typeof skill.handleMessage === 'function') {
        const session = this.sessionManager.getOrCreateSession(state.sessionKey, state.agentId, {
          channel: 'telegram',
          peer: chatId,
          label: `telegram:${chatId}`
        });

        const result = await skill.handleMessage(text, {
          chatId,
          channel: 'telegram',
          userId: chatId,
          session
        });

        if (result !== null) {
          const responseText = result.ok
            ? (result.message || 'Done.')
            : `❌ ${result.error || 'Error'}`;

          await this.sendMessage(chatId, responseText);
          this.addToLocalChat(chatId, 'assistant', responseText);

          if (!result.continueWithAgent) {
            return;
          }
        }
      }
    }

    await this.routeAgentMessage(chatId, text);
  }

  async handleCommand(chatId, text) {
    const [rawCommand, ...rest] = String(text || '').split(/\s+/);
    const command = String(rawCommand || '').toLowerCase();
    const arg = rest.join(' ').trim();
    const state = this.getOrCreateChatState(chatId);

    if (command === '/pin') {
      const skillId = arg;
      if (!skillId) {
        await this.sendMessage(chatId, 'Usage: /pin <skill-id>');
        return;
      }

      const skill = skillRegistry.getSkill(skillId);
      if (!skill) {
        await this.sendMessage(chatId, `Unknown skill: ${skillId}`);
        return;
      }

      if (!skill.getMetadata().pinnable) {
        await this.sendMessage(chatId, `Skill '${skillId}' does not support pinning.`);
        return;
      }

      if (!this.pinManager) {
        await this.sendMessage(chatId, 'Pin manager is not available.');
        return;
      }

      await this.pinManager.pin(state.sessionKey, skillId);
      const meta = skill.getMetadata();
      await this.sendMessage(
        chatId,
        `📌 Pinned ${meta.name} to this chat. All messages will be handled by ${meta.name}. Use /unpin to restore normal behavior.`
      );
      return;
    }

    if (command === '/unpin') {
      if (!this.pinManager) {
        await this.sendMessage(chatId, 'Pin manager is not available.');
        return;
      }

      const pinnedId = this.pinManager.getPinned(state.sessionKey);
      if (!pinnedId) {
        await this.sendMessage(chatId, 'No skill is currently pinned.');
        return;
      }

      await this.pinManager.unpin(state.sessionKey);
      const label = skillRegistry.getSkill(pinnedId)?.getMetadata()?.name || pinnedId;
      await this.sendMessage(chatId, `📌 Unpinned ${label}. Normal behavior restored.`);
      return;
    }

    if (command === '/pinned') {
      if (!this.pinManager) {
        await this.sendMessage(chatId, 'Pin manager is not available.');
        return;
      }

      const pinnedId = this.pinManager.getPinned(state.sessionKey);
      if (!pinnedId) {
        await this.sendMessage(chatId, 'No skill is currently pinned to this chat.');
        return;
      }

      const skill = skillRegistry.getSkill(pinnedId);
      const name = skill?.getMetadata()?.name || pinnedId;
      await this.sendMessage(chatId, `📌 Pinned skill: ${name} (${pinnedId})`);
      return;
    }

    // Check if this is a skill command
    const commandName = command.startsWith('/') ? command.slice(1) : command;
    const skill = skillRegistry.getSkillForCommand(commandName);
    if (skill) {
      try {
        const session = this.sessionManager.getOrCreateSession(state.sessionKey, state.agentId, {
          channel: 'telegram',
          peer: chatId,
          label: `telegram:${chatId}`
        });

        const result = await skill.handleCommand(commandName, rest, {
          chatId,
          channel: 'telegram',
          userId: chatId, // In Telegram, chatId serves as userId for now
          session
        });

        if (result.ok) {
          await this.sendMessage(chatId, result.message || 'Command executed successfully.');
        } else {
          await this.sendMessage(chatId, `❌ Error: ${result.error || 'Unknown error'}`);
        }
      } catch (error) {
        console.error(`[telegram-bridge] Skill command error:`, error);
        await this.sendMessage(chatId, `❌ Error executing command: ${error.message}`);
      }
      return;
    }

    if (command === '/help' || command === '/start') {
      await this.sendMessage(
        chatId,
        formatHelp({
          agents: this.listAgents(),
          currentAgent: state.agentId,
          skills: skillRegistry.listSkills()
        })
      );
      return;
    }

    if (command === '/status') {
      const status = {
        gateway: {
          host: this.gateway.host,
          port: this.gateway.port,
          connections: this.gateway.connections.size
        },
        sessions: {
          total: this.sessionManager.listSessions().length
        }
      };

      await this.sendMessage(chatId, formatStatus(status));
      return;
    }

    if (command === '/clear') {
      const cleared = this.sessionManager.clearSession(state.sessionKey);
      await this.sendMessage(chatId, cleared ? '🧹 Session history cleared.' : 'No active session to clear.');
      return;
    }

    if (command === '/agent') {
      if (!arg) {
        await this.sendMessage(
          chatId,
          `Current agent: ${state.agentId}\nUse /agent <name> to switch.`
        );
        return;
      }

      const next = this.getAgent(arg);
      if (!next) {
        await this.sendMessage(chatId, `Unknown agent: ${arg}`);
        return;
      }

      state.agentId = next.id;
      state.sessionKey = this.sessionManager.buildSessionKey(next.id, 'telegram', chatId);
      this.sessionManager.getOrCreateSession(state.sessionKey, next.id, {
        channel: 'telegram',
        peer: chatId,
        label: `telegram:${chatId}`
      });

      await this.sendMessage(chatId, `✅ Active agent set to: ${next.id}`);
      return;
    }

    await this.sendMessage(chatId, 'Unknown command. Use /help.');
  }

  async routeAgentMessage(chatId, text) {
    const state = this.getOrCreateChatState(chatId);
    const session = this.sessionManager.getOrCreateSession(state.sessionKey, state.agentId, {
      channel: 'telegram',
      peer: chatId,
      label: `telegram:${chatId}`
    });

    this.sessionManager.addMessage(session.key, {
      role: 'user',
      content: text,
      from: `telegram:${chatId}`
    });

    const runId = `tg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.pendingRuns.set(runId, {
      chatId,
      sessionKey: session.key,
      startedAt: Date.now()
    });

    await this.gateway.sendToAgent(state.agentId, session.key, {
      runId,
      message: text,
      from: `telegram:${chatId}`,
      channel: 'telegram',
      approvalHandler: this.createApprovalHandler(chatId)
    });
  }

  createApprovalHandler(chatId) {
    return async ({ toolName, parameters }) => {
      const approvalId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const callbackApprove = `kl_a_${approvalId}_y`;
      const callbackDeny = `kl_a_${approvalId}_n`;

      await this.sendMessage(chatId, formatApprovalRequest({ toolName, parameters }), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: callbackApprove },
              { text: '❌ Deny', callback_data: callbackDeny }
            ]
          ]
        }
      });

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pendingApprovals.delete(approvalId);
          resolve(false);
        }, 120000);

        this.pendingApprovals.set(approvalId, {
          chatId,
          resolve,
          timer
        });
      });
    };
  }

  async handleCallbackQuery(query = {}) {
    const data = String(query.data || '');
    const chatId = String(query?.message?.chat?.id || '');
    const callbackId = String(query.id || '');

    const match = data.match(/^kl_a_([a-z0-9]+)_(y|n)$/i);
    if (!match) {
      await this.answerCallbackQuery(callbackId, 'Unknown action');
      return;
    }

    const approvalId = match[1];
    const approved = match[2].toLowerCase() === 'y';
    const pending = this.pendingApprovals.get(approvalId);

    if (!pending) {
      await this.answerCallbackQuery(callbackId, 'This approval has expired.');
      return;
    }

    if (pending.chatId !== chatId) {
      await this.answerCallbackQuery(callbackId, 'Only the originating chat can approve this action.');
      return;
    }

    this.pendingApprovals.delete(approvalId);
    clearTimeout(pending.timer);
    pending.resolve(approved);

    await this.answerCallbackQuery(callbackId, approved ? 'Approved' : 'Denied');
    await this.sendMessage(chatId, approved ? '✅ Tool execution approved.' : '❌ Tool execution denied.');
  }

  async answerCallbackQuery(callbackQueryId, text) {
    if (!callbackQueryId) return;
    try {
      await this.callTelegram('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text
      });
    } catch {
      // ignore callback answer failures
    }
  }

  async handleAgentResponse(response = {}) {
    const runId = response.runId;
    if (!runId || !this.pendingRuns.has(runId)) return;

    const run = this.pendingRuns.get(runId);
    this.pendingRuns.delete(runId);

    if (response.error) {
      const errorMsg = `❌ Agent error: ${response.error}`;
      await this.sendMessage(run.chatId, errorMsg);
      // Add error to local chat
      this.addToLocalChat(run.chatId, 'assistant', errorMsg);
      return;
    }

    const content = response.content || '(No response)';

    // Add assistant response to local chat
    this.addToLocalChat(run.chatId, 'assistant', content);

    // Send to Telegram (split if needed)
    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await this.sendMessage(run.chatId, chunk);
    }
  }

  async sendMessage(chatId, text, extra = {}) {
    return this.callTelegram('sendMessage', {
      chat_id: Number(chatId),
      text: String(text || ''),
      ...extra
    });
  }

  async callTelegram(method, payload = {}, options = {}) {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: options.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Telegram ${method} failed: ${response.status} ${response.statusText} ${text}`);
    }

    const json = await response.json();
    if (!json.ok) {
      throw new Error(`Telegram ${method} error: ${json.description || 'Unknown error'}`);
    }

    return json.result;
  }
}

module.exports = TelegramBridge;