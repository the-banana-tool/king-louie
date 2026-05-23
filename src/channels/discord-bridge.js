const crypto = require('crypto');
const { ChannelPlugin } = require('./channel-plugin');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
  splitMessage,
  formatHelp,
  formatStatus,
  formatApprovalRequest
} = require('./discord-adapter');
const { shouldRespond } = require('./mention-gating');
const { skillRegistry } = require('../skills');
const { createLogger } = require('../logging');
const log = createLogger('discord-bridge');

class DiscordChannel extends ChannelPlugin {
  constructor(options = {}) {
    super({
      id: 'discord',
      label: 'Discord',
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
        : () => ({ enabled: false, thresholdsMs: { external: 120000 } });
    this.getVoiceSettings =
      typeof options.getVoiceSettings === 'function'
        ? options.getVoiceSettings
        : () => ({ enabled: false });
    this.getTtsEngine =
      typeof options.getTtsEngine === 'function'
        ? options.getTtsEngine
        : () => null;

    // Callbacks for local chat management
    this.createLocalChat = options.createLocalChat || (() => null);
    this.addMessageToLocalChat = options.addMessageToLocalChat || (() => {});

    this.running = false;
    this.connected = false;
    this.client = null;
    this.botUserId = null;
    this.messageHandlers = new Set();

    this.chatState = new Map();
    this.pendingRuns = new Map();
    this.pendingApprovals = new Map();
    this.discordToLocalChatMap = new Map();

    this.boundAgentResponse = this.handleAgentResponse.bind(this);
  }

  async initialize(gateway) {
    if (gateway) {
      this.gateway = gateway;
    }

    if (this.running) return;
    if (!this.token) {
      throw new Error('Discord bridge requires a bot token');
    }
    if (!this.gateway) {
      throw new Error('Discord bridge requires a gateway server');
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message]
    });

    this.client.on('ready', () => {
      this.botUserId = this.client.user.id;
      this.connected = true;
    });

    this.client.on('messageCreate', this.handleMessageCreate.bind(this));
    this.client.on('interactionCreate', this.handleInteractionCreate.bind(this));

    this.client.on('error', (err) => {
      log.error(`client error: ${err.message}`);
    });

    try {
      await this.client.login(this.token);
    } catch (err) {
      this.connected = false;
      throw new Error(`Discord login failed: ${err.message}`);
    }

    this.running = true;
    this.gateway.on('agent:response', this.boundAgentResponse);
  }

  async shutdown() {
    if (!this.running) return;

    this.running = false;
    this.connected = false;
    this.gateway.off('agent:response', this.boundAgentResponse);

    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    for (const approval of this.pendingApprovals.values()) {
      approval.resolve(false);
      clearTimeout(approval.timer);
    }
    this.pendingApprovals.clear();
  }

  normalizeTarget(rawTarget = '') {
    if (rawTarget && typeof rawTarget === 'object') {
      return String(rawTarget.channelId || rawTarget.userId || rawTarget.id || '').trim();
    }
    return String(rawTarget || '').trim();
  }

  supportsGroups() {
    return true;
  }

  getMentionPattern() {
    if (!this.botUserId) return null;
    return new RegExp(`<@!?${this.botUserId}>`, 'i');
  }

  static buildSessionKey(userId, group = null) {
    if (group && group.guildId && group.channelId) {
      return `agent:main:discord:group:${group.guildId}:${group.channelId}`;
    }
    return `agent:main:discord:${userId}`;
  }

  hasMention(text) {
    const mentionPattern = this.getMentionPattern();
    if (mentionPattern && mentionPattern.test(text || '')) {
      return true;
    }
    return false;
  }

  normalizeInboundMessage(message) {
    const isGroup = !!message.guildId;

    const mentions = message.mentions.users.map(u => u.id);
    const text = message.content || '';

    const attachments = [];
    message.attachments.forEach(att => {
      if (att.contentType && att.contentType.startsWith('image/')) {
        attachments.push({ type: 'photo', url: att.url });
      } else {
        attachments.push({ type: 'document', name: att.name || '', url: att.url });
      }
    });

    return {
      channel: 'discord',
      sender: {
        id: message.author.id,
        name: message.author.username,
        isGroup
      },
      group: isGroup ? {
        id: message.channelId,
        channelId: message.channelId,
        guildId: message.guildId,
        name: message.channel?.name || ''
      } : null,
      text,
      mentions,
      attachments,
      threadId: message.thread?.id || null,
      raw: message
    };
  }

  async handleMessageCreate(message) {
    if (message.author.bot) return;
    if (message.author.id === this.botUserId) return;

    const inbound = this.normalizeInboundMessage(message);
    const text = inbound.text;

    const channelSettings = this.getChannelSettings() || {};
    const isGroup = Boolean(inbound.group);
    const isCommand = text.startsWith('/');
    const isReply = message.reference ? true : false;
    const wasMentioned = this.hasMention(text) || message.mentions.has(this.client.user);

    if (this.allowlistManager && !this.allowlistManager.isAllowed('discord', inbound.sender.id, inbound.group?.id || null)) {
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

    this.getOrCreateChatState(message.channelId, inbound.group, message.author.id);
    await this.emitInbound(inbound);

    // Callbacks to local chat management
    const userName = inbound.sender.name;
    this.getOrCreateLocalChat(message.channelId, userName);

    if (text.startsWith('/')) {
      await this.handleCommand(message.channelId, text, message.author.id, inbound.group);
      return;
    }

    if (!text) {
      await this.sendMessage(message.channelId, 'Send text or use /help for available commands.');
      return;
    }

    this.addToLocalChat(message.channelId, 'user', text);

    const state = this.getOrCreateChatState(message.channelId, inbound.group, message.author.id);
    const pinnedSkillId = this.pinManager?.getPinned(state.sessionKey);
    if (pinnedSkillId) {
      const skill = skillRegistry.getSkill(pinnedSkillId);
      if (skill && typeof skill.handleMessage === 'function') {
        const session = this.sessionManager.getOrCreateSession(state.sessionKey, state.agentId, {
          channel: 'discord',
          peer: message.channelId,
          label: `discord:${message.channelId}`
        });

        try {
          const result = await skill.handleMessage(text, { chatId: message.channelId, channel: 'discord', userId: message.author.id, session });
          if (result !== null) {
            if (result.ok) {
              await this.sendMessage(message.channelId, result.message || 'Done.');
              this.addToLocalChat(message.channelId, 'assistant', result.message || 'Done.');
            } else {
              const errorMsg = `❌ ${result.error || 'Error'}`;
              await this.sendMessage(message.channelId, errorMsg);
              this.addToLocalChat(message.channelId, 'assistant', errorMsg);
            }
            if (!result.continueWithAgent) return;
          }
        } catch (error) {
          log.error(`Pinned skill error: ${error.message}`);
          await this.sendMessage(message.channelId, `❌ Pinned skill error: ${error.message}`);
          return;
        }
      }
    }

    await this.routeAgentMessage(message.channelId, text, message.author.id, inbound.group);
  }

  async routeAgentMessage(chatId, text, userId, group) {
    const state = this.getOrCreateChatState(chatId, group, userId);
    const session = this.sessionManager.getOrCreateSession(state.sessionKey, state.agentId, {
      channel: 'discord',
      peer: chatId,
      label: `discord:${chatId}`
    });

    this.sessionManager.addMessage(session.key, {
      role: 'user',
      content: text,
      from: `discord:${chatId}`
    });

    const runId = `dc_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    this.pendingRuns.set(runId, {
      chatId,
      sessionKey: session.key,
      startedAt: Date.now()
    });

    await this.gateway.sendToAgent(state.agentId, session.key, {
      runId,
      message: text,
      from: `discord:${chatId}`,
      channel: 'discord',
      startedAt: Date.now(),
      approvalHandler: this.createApprovalHandler(chatId)
    });
  }

  createApprovalHandler(chatId) {
    return async ({ toolName, parameters }) => {
      const approvalId = crypto.randomBytes(16).toString('hex');
      const callbackApprove = `kl_a_${approvalId}_y`;
      const callbackDeny = `kl_a_${approvalId}_n`;

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(callbackApprove)
            .setLabel('✅ Approve')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(callbackDeny)
            .setLabel('❌ Deny')
            .setStyle(ButtonStyle.Danger)
        );

      await this.sendMessage(chatId, formatApprovalRequest({ toolName, parameters }), {
        components: [row]
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

  getOrCreateChatState(chatId, group = null, userId = null) {
    const key = String(chatId);
    if (!this.chatState.has(key)) {
      const agentId = 'main';
      const sessionKey = DiscordChannel.buildSessionKey(userId, group);
      this.chatState.set(key, {
        chatId: key,
        agentId,
        group: group && group.guildId ? group : null,
        sessionKey
      });
    } else if (group && group.guildId) {
      const state = this.chatState.get(key);
      state.group = group;
    }
    return this.chatState.get(key);
  }

  getOrCreateLocalChat(discordChatId, userName = 'Unknown') {
    const key = String(discordChatId);
    if (this.discordToLocalChatMap.has(key)) {
      return this.discordToLocalChatMap.get(key);
    }
    const chatTitle = `👾 Discord: ${userName} (${discordChatId})`;
    const localChatId = this.createLocalChat(chatTitle);
    if (localChatId) {
      this.discordToLocalChatMap.set(key, localChatId);
    }
    return localChatId;
  }

  addToLocalChat(discordChatId, sender, text) {
    const localChatId = this.discordToLocalChatMap.get(String(discordChatId));
    if (localChatId) {
      this.addMessageToLocalChat(localChatId, sender, text);
    }
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

  async onMessage(handler) {
    if (typeof handler === 'function') {
      this.messageHandlers.add(handler);
    }
  }

  async sendMessage(chatId, text, options = {}) {
    return this.send(chatId, text, options);
  }

  async handleCommand(chatId, text, userId, group) {
    const [rawCommand, ...rest] = String(text || '').split(/\s+/);
    const command = String(rawCommand || '').toLowerCase();
    const arg = rest.join(' ').trim();
    const state = this.getOrCreateChatState(chatId, group, userId);

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

    const commandName = command.startsWith('/') ? command.slice(1) : command;
    const skill = skillRegistry.getSkillForCommand(commandName);
    if (skill) {
      try {
        const session = this.sessionManager.getOrCreateSession(state.sessionKey, state.agentId, {
          channel: 'discord',
          peer: chatId,
          label: `discord:${chatId}`
        });
        const forcePrompt = rest.includes('--force-prompt');
        const sanitizedArgs = rest.filter((arg) => arg !== '--force-prompt');

        const result = await skillRegistry.executeCommand(
          commandName,
          sanitizedArgs,
          { chatId, channel: 'discord', userId: userId, session },
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
      state.sessionKey = DiscordChannel.buildSessionKey(userId, group);
      this.sessionManager.getOrCreateSession(state.sessionKey, next.id, {
        channel: 'discord',
        peer: chatId,
        label: `discord:${chatId}`
      });

      await this.sendMessage(chatId, `✅ Active agent set to: ${next.id}`);
      return;
    }

    await this.sendMessage(chatId, 'Unknown command. Use /help.');
  }

  async send(target, message, options = {}) {
    const targetId = this.normalizeTarget(target);
    if (!targetId) {
      throw new Error('Invalid Discord target: expected channel/user id');
    }

    const payload = typeof message === 'string' ? { content: message, ...options } : message;

    const channel = await this.client.channels.fetch(targetId).catch(() => null);
    if (channel && channel.isTextBased()) {
      return channel.send(payload);
    }

    const user = await this.client.users.fetch(targetId).catch(() => null);
    if (user) {
      return user.send(payload);
    }

    throw new Error(`Could not find channel or user with id ${targetId}`);
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
      this.addToLocalChat(run.chatId, 'assistant', errorMsg);
      return;
    }

    const content = response.content || '(No response)';
    this.addToLocalChat(run.chatId, 'assistant', content);

    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await this.sendMessage(run.chatId, chunk);
    }

    const notifications = this.getNotificationSettings() || {};
    const thresholds = notifications.thresholdsMs || {};
    const externalThreshold = Number(thresholds.external || 120000);
    const longTaskNoticeEnabled = notifications.discord?.longTaskNotice !== false;

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

  async handleInteractionCreate(interaction) {
    if (!interaction.isButton()) return;

    const callbackId = interaction.customId;
    const match = callbackId.match(/^kl_a_([a-z0-9]+)_(y|n)$/i);
    if (!match) return;

    const approvalId = match[1];
    const approved = match[2].toLowerCase() === 'y';
    const pending = this.pendingApprovals.get(approvalId);

    if (!pending) {
      await interaction.reply({ content: 'This approval has expired.', ephemeral: true });
      return;
    }

    if (pending.chatId !== interaction.channelId) {
      await interaction.reply({ content: 'Only the originating chat can approve this action.', ephemeral: true });
      return;
    }

    this.pendingApprovals.delete(approvalId);
    clearTimeout(pending.timer);
    pending.resolve(approved);

    await interaction.reply({ content: approved ? 'Approved' : 'Denied' });
    await this.sendMessage(interaction.channelId, approved ? '✅ Tool execution approved.' : '❌ Tool execution denied.');
  }
}

module.exports = DiscordChannel;