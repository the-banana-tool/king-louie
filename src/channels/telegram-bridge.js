const crypto = require('crypto');
const {
  splitMessage,
  formatHelp,
  formatStatus,
  formatApprovalRequest
} = require('./telegram-adapter');
const { ChannelPlugin } = require('./channel-plugin');
const { shouldRespond } = require('./mention-gating');
const { skillRegistry } = require('../skills');
const { createLogger } = require('../logging');
const log = createLogger('telegram-bridge');

class TelegramBridge extends ChannelPlugin {
  constructor(options = {}) {
    super({
      id: 'telegram',
      label: 'Telegram',
      capabilities: ['send', 'receive']
    });

    this.token = options.token;
    this.gateway = options.gatewayServer;
    this.sessionManager = options.sessionManager;
    this.allowlistManager = options.allowlistManager || null;
    this.getAgent = options.getAgent || (() => null);
    this.listAgents = options.listAgents || (() => []);
    this.getChannelSettings =
      typeof options.getChannelSettings === 'function'
        ? options.getChannelSettings
        : () => ({ requireMention: false });
    this.pinManager = options.pinManager || null;
    this.getNotificationSettings =
      typeof options.getNotificationSettings === 'function'
        ? options.getNotificationSettings
        : () => ({ enabled: false, thresholdsMs: { external: 120000 }, telegram: { longTaskNotice: false } });
    this.getVoiceSettings =
      typeof options.getVoiceSettings === 'function'
        ? options.getVoiceSettings
        : () => ({
          enabled: false,
          telegramVoiceForLongResponses: false,
          telegramMinChars: 500,
          summaryMaxChars: 260
        });
    this.getTtsEngine =
      typeof options.getTtsEngine === 'function'
        ? options.getTtsEngine
        : () => null;
    this.pollTimeoutSeconds = Number(options.pollTimeoutSeconds || 30);

    // Callbacks for local chat management
    this.createLocalChat = options.createLocalChat || (() => null);
    this.addMessageToLocalChat = options.addMessageToLocalChat || (() => {});

    this.apiBase = `https://api.telegram.org/bot${this.token}`;
    this.offset = 0;
    this.running = false;
    this.connected = false;
    this.botUsername = null;
    this.botId = null;
    this.pollAbortController = null;
    this.messageHandlers = new Set();

    this.chatState = new Map();
    this.pendingRuns = new Map();
    this.pendingApprovals = new Map();
    this.telegramToLocalChatMap = new Map(); // Maps Telegram chat ID to local King Louie chat ID

    this.boundAgentResponse = this.handleAgentResponse.bind(this);
  }

  async initialize(gateway) {
    if (gateway) {
      this.gateway = gateway;
    }

    if (this.running) return;
    if (!this.token) {
      throw new Error('Telegram bridge requires a bot token');
    }
    if (!this.gateway) {
      throw new Error('Telegram bridge requires a gateway server');
    }

    try {
      const me = await this.callTelegram('getMe', {});
      this.botUsername = String(me?.username || '').trim() || null;
      this.botId = me?.id != null ? String(me.id) : null;
      this.connected = true;
    } catch (error) {
      this.connected = false;
      throw error;
    }

    this.running = true;
    this.gateway.on('agent:response', this.boundAgentResponse);
    this.pollLoop().catch((error) => {
      log.error(`polling failed: ${error.message}`);
    });
  }

  async shutdown() {
    if (!this.running) return;

    this.running = false;
    this.connected = false;
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

  async start() {
    return this.initialize(this.gateway);
  }

  async stop() {
    return this.shutdown();
  }

  normalizeTarget(rawTarget = '') {
    if (rawTarget && typeof rawTarget === 'object') {
      return String(rawTarget.chatId || rawTarget.id || '').trim();
    }
    return String(rawTarget || '').trim();
  }

  async send(target, message, options = {}) {
    const chatId = this.normalizeTarget(target);
    if (!chatId) {
      throw new Error('Invalid Telegram target: expected chat id');
    }
    return this.sendMessage(chatId, message, options);
  }

  async onMessage(handler) {
    if (typeof handler === 'function') {
      this.messageHandlers.add(handler);
    }
  }

  getStatus() {
    return {
      connected: this.connected,
      running: this.running,
      pendingRuns: this.pendingRuns.size,
      pendingApprovals: this.pendingApprovals.size
    };
  }

  supportsGroups() {
    return true;
  }

  async listTargets() {
    return Array.from(this.chatState.values()).map((state) => ({
      id: state.chatId,
      label: state.group ? `group:${state.group.name || state.chatId}` : `user:${state.chatId}`,
      isGroup: Boolean(state.group)
    }));
  }

  async listGroups() {
    return Array.from(this.chatState.values())
      .filter((state) => Boolean(state.group))
      .map((state) => ({ ...state.group }));
  }

  getMentionPattern() {
    if (!this.botUsername) {
      return null;
    }
    return new RegExp(`@${this.botUsername}(\\b|$)`, 'i');
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
          log.error(`update handling error: ${error.message}`);
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

  getOrCreateChatState(chatId, group = null) {
    const key = String(chatId);
    if (!this.chatState.has(key)) {
      const agentId = 'main';
      this.chatState.set(key, {
        chatId: key,
        agentId,
        group: group && group.id ? group : null,
        sessionKey: this.sessionManager.buildSessionKey(agentId, 'telegram', key)
      });
    } else if (group && group.id) {
      const state = this.chatState.get(key);
      state.group = group;
    }

    return this.chatState.get(key);
  }

  normalizeInboundMessage(message = {}) {
    const chat = message?.chat || {};
    const from = message?.from || {};
    const chatType = String(chat.type || '').toLowerCase();
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    const mentions = [];
    const entities = Array.isArray(message.entities) ? message.entities : [];
    const text = String(message.text || '').trim();
    for (const entity of entities) {
      if (entity?.type === 'mention') {
        const offset = Number(entity.offset) || 0;
        const length = Number(entity.length) || 0;
        const mentionText = text.slice(offset, offset + length);
        if (mentionText) mentions.push(mentionText);
      }
      if (entity?.type === 'text_mention' && entity.user) {
        mentions.push(String(entity.user.username || entity.user.id || '').trim());
      }
    }

    const attachments = [];
    if (Array.isArray(message.photo) && message.photo.length) attachments.push({ type: 'photo' });
    if (message.document) attachments.push({ type: 'document', name: message.document.file_name || '' });
    if (message.audio) attachments.push({ type: 'audio', name: message.audio.file_name || '' });
    if (message.video) attachments.push({ type: 'video', name: message.video.file_name || '' });

    return {
      channel: 'telegram',
      sender: {
        id: String(from.id || chat.id || ''),
        name: from.username || [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || 'User',
        isGroup
      },
      group: isGroup
        ? {
            id: String(chat.id || ''),
            name: chat.title || ''
          }
        : null,
      text,
      mentions,
      attachments,
      threadId: message.message_thread_id != null
        ? String(message.message_thread_id)
        : null,
      raw: message
    };
  }

  isMentioned(message = {}, inbound = {}) {
    const mentionPattern = this.getMentionPattern();
    if (mentionPattern && mentionPattern.test(inbound.text || '')) {
      return true;
    }

    const entities = Array.isArray(message.entities) ? message.entities : [];
    for (const entity of entities) {
      if (entity?.type === 'text_mention' && entity.user) {
        const entityId = String(entity.user.id || '');
        if (this.botId && entityId && entityId === this.botId) {
          return true;
        }
      }
    }

    return false;
  }

  async emitInbound(inboundMessage) {
    if (!this.messageHandlers.size) return;

    for (const handler of this.messageHandlers) {
      try {
        await handler(inboundMessage);
      } catch (error) {
        log.warn(`inbound handler failed: ${error.message}`);
      }
    }
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
    const inbound = this.normalizeInboundMessage(message);
    const chatId = String(message?.chat?.id || '');
    const text = inbound.text;
    if (!chatId) return;

    const channelSettings = this.getChannelSettings() || {};
    const isGroup = Boolean(inbound.group);
    const isCommand = text.startsWith('/');
    const isReply = Boolean(message.reply_to_message);
    const wasMentioned = this.isMentioned(message, inbound);

    if (this.allowlistManager && !this.allowlistManager.isAllowed('telegram', inbound.sender.id, inbound.group?.id || null)) {
      return;
    }

    if (!shouldRespond({
      isGroup,
      requireMention: channelSettings.requireMention === true,
      wasMentioned,
      isCommand,
      isReply
    })) {
      return;
    }

    this.getOrCreateChatState(chatId, inbound.group);
    await this.emitInbound(inbound);

    // Get user info for chat title
    const userName = inbound.sender.name;

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

    // Check if chat has a pinned skill
    const state = this.getOrCreateChatState(chatId, inbound.group);
    const pinnedSkillId = this.pinManager?.getPinned(state.sessionKey);
    if (pinnedSkillId) {
      const skill = skillRegistry.getSkill(pinnedSkillId);
      if (skill && typeof skill.handleMessage === 'function') {
        const session = this.sessionManager.getOrCreateSession(state.sessionKey, state.agentId, {
          channel: 'telegram',
          peer: chatId,
          label: `telegram:${chatId}`
        });

        try {
          const result = await skill.handleMessage(text, { chatId, channel: 'telegram', userId: chatId, session });
          if (result !== null) {
            if (result.ok) {
              await this.sendMessage(chatId, result.message || 'Done.');
              this.addToLocalChat(chatId, 'assistant', result.message || 'Done.');
            } else {
              const errorMsg = `❌ ${result.error || 'Error'}`;
              await this.sendMessage(chatId, errorMsg);
              this.addToLocalChat(chatId, 'assistant', errorMsg);
            }
            if (!result.continueWithAgent) return; // Skip AI
          }
        } catch (error) {
          log.error(`Pinned skill error: ${error.message}`);
          await this.sendMessage(chatId, `❌ Pinned skill error: ${error.message}`);
          return;
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
      if (!this.pinManager) {
        await this.sendMessage(chatId, '❌ Pinning feature not available.');
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
      await this.pinManager.pin(state.sessionKey, skillId);
      await this.sendMessage(chatId, `📌 Pinned ${skill.getMetadata().name} to this chat. All messages will be handled by ${skill.getMetadata().name}. Use /unpin to restore normal behavior.`);
      return;
    }

    if (command === '/unpin') {
      if (!this.pinManager) {
        await this.sendMessage(chatId, '❌ Pinning feature not available.');
        return;
      }
      const pinnedId = this.pinManager.getPinned(state.sessionKey);
      await this.pinManager.unpin(state.sessionKey);
      const label = pinnedId ? skillRegistry.getSkill(pinnedId)?.getMetadata().name || pinnedId : null;
      await this.sendMessage(chatId, label ? `📌 Unpinned ${label}. Normal behavior restored.` : 'No skill is currently pinned.');
      return;
    }

    if (command === '/pinned') {
      if (!this.pinManager) {
        await this.sendMessage(chatId, '❌ Pinning feature not available.');
        return;
      }
      const pinnedId = this.pinManager.getPinned(state.sessionKey);
      if (!pinnedId) {
        await this.sendMessage(chatId, 'No skill is currently pinned to this chat.');
        return;
      }
      const skill = skillRegistry.getSkill(pinnedId);
      const name = skill?.getMetadata().name || pinnedId;
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

        const forcePrompt = rest.includes('--force-prompt');
        const sanitizedArgs = rest.filter((arg) => arg !== '--force-prompt');

        const result = await skillRegistry.executeCommand(
          commandName,
          sanitizedArgs,
          {
            chatId,
            channel: 'telegram',
            userId: chatId, // In Telegram, chatId serves as userId for now
            session
          },
          { forcePrompt }
        );

        if (result.ok) {
          await this.sendMessage(chatId, result.message || 'Command executed successfully.');
        } else {
          await this.sendMessage(chatId, `❌ Error: ${result.error || 'Unknown error'}`);
        }
      } catch (error) {
        log.error(`Skill command error: ${error.message}`);
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

    const runId = `tg_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
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
      startedAt: Date.now(),
      approvalHandler: this.createApprovalHandler(chatId)
    });
  }

  createApprovalHandler(chatId) {
    return async ({ toolName, parameters }) => {
      const approvalId = crypto.randomBytes(16).toString('hex');
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
    const durationMs = Number(response.durationMs || Date.now() - Number(run.startedAt || Date.now()));

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

    const voiceSettings = this.getVoiceSettings() || {};
    if (
      voiceSettings.enabled === true
      && voiceSettings.telegramVoiceForLongResponses === true
      && content.length >= Number(voiceSettings.telegramMinChars || 500)
    ) {
      try {
        const ttsEngine = this.getTtsEngine();
        if (ttsEngine && typeof ttsEngine.speakSummary === 'function') {
          const voiceResult = await ttsEngine.speakSummary(content, {
            ...voiceSettings,
            summaryMaxChars: Number(voiceSettings.summaryMaxChars || 260)
          });

          const audioBuffer = voiceResult?.audio?.buffer;
          if (audioBuffer && Buffer.isBuffer(audioBuffer)) {
            await this.sendVoice(
              run.chatId,
              audioBuffer,
              `response-${Date.now()}.mp3`,
              'audio/mpeg',
              '🔊 Voice summary'
            );
          }
        }
      } catch (error) {
        log.warn(`Unable to send voice response: ${error.message}`);
      }
    }

    const notifications = this.getNotificationSettings() || {};
    const thresholds = notifications.thresholdsMs || {};
    const externalThreshold = Number(thresholds.external || 120000);
    const longTaskNoticeEnabled = notifications.telegram?.longTaskNotice !== false;
    if (
      notifications.enabled !== false
      && longTaskNoticeEnabled
      && durationMs >= externalThreshold
    ) {
      await this.sendMessage(
        run.chatId,
        `⏱️ Long task complete in ${Math.round(durationMs / 1000)}s.`
      );
    }
  }

  async sendMessage(chatId, text, extra = {}) {
    return this.callTelegram('sendMessage', {
      chat_id: Number(chatId),
      text: String(text || ''),
      ...extra
    });
  }

  async sendVoice(chatId, audioBuffer, fileName = 'voice.mp3', mimeType = 'audio/mpeg', caption = '') {
    const formData = new FormData();
    formData.append('chat_id', String(Number(chatId)));
    if (caption) {
      formData.append('caption', String(caption));
    }

    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('voice', blob, fileName);

    const response = await fetch(`${this.apiBase}/sendVoice`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Telegram sendVoice failed: ${response.status} ${response.statusText} ${text}`);
    }

    const json = await response.json();
    if (!json.ok) {
      throw new Error(`Telegram sendVoice error: ${json.description || 'Unknown error'}`);
    }

    return json.result;
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