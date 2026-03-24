const { ChannelPlugin } = require('./channel-plugin');
const { App } = require('@slack/bolt');
const { shouldRespond } = require('./mention-gating');

class SlackChannel extends ChannelPlugin {
  constructor(config = {}) {
    super({
      id: 'slack',
      label: 'Slack',
      capabilities: ['send', 'receive']
    });

    this.enabled = config.enabled || false;
    this.appToken = config.appToken;
    this.botToken = config.botToken;
    this.requireMention = config.requireMention !== false;
    this.allowedChannels = config.allowedChannels || [];

    this.botUserId = config.botUserId || null;
    this.app = null;
    this.gateway = null;
  }

  static buildSessionKey(userId, group = null) {
    if (group && group.channelId) {
      return `agent:main:slack:group:${group.channelId}`;
    }
    return `agent:main:slack:${userId}`;
  }

  async initialize(gateway) {
    if (!this.enabled || !this.appToken || !this.botToken) {
      console.log('[slack] missing config or disabled, skipping initialization');
      return;
    }

    this.gateway = gateway;

    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      // Suppress bolt framework's default logging to keep console clean
      logger: {
        debug: () => {},
        info: () => {},
        warn: console.warn,
        error: console.error,
        setLevel: () => {},
        getLevel: () => 'warn',
        setName: () => {}
      }
    });

    // Check bot identity to get our own bot user ID (so we can check mentions)
    try {
      const authInfo = await this.app.client.auth.test();
      this.botUserId = authInfo.user_id;
      console.log(`[slack] connected as @${authInfo.user} (${this.botUserId})`);
    } catch (err) {
      throw new Error(`Slack auth failed: ${err.message}`);
    }

    // Listen for mentions in channels
    this.app.event('app_mention', async ({ event, say }) => {
      await this.handleMessageEvent(event, say, true);
    });

    // Listen for direct messages (and unmentioned channel messages, which we filter)
    this.app.message(async ({ event, say }) => {
      // Avoid processing mentions twice (app_mention also triggers message event sometimes)
      if (event.type === 'message' && event.channel_type !== 'im' && this.hasMention(event.text)) {
        return;
      }
      await this.handleMessageEvent(event, say, false);
    });

    await this.app.start();
    console.log('[slack] socket mode client started');
  }

  async shutdown() {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      console.log('[slack] socket mode client stopped');
    }
  }

  normalizeTarget(rawTarget) {
    if (typeof rawTarget === 'string') {
      return { channelId: rawTarget };
    }
    return rawTarget;
  }

  supportsGroups() {
    return true;
  }

  getMentionPattern() {
    if (!this.botUserId) return null;
    return new RegExp(`<@${this.botUserId}>`);
  }

  hasMention(text) {
    if (!text) return false;
    const pattern = this.getMentionPattern();
    return pattern ? pattern.test(text) : false;
  }

  formatResponse(text) {
    if (!text) return [{ type: 'section', text: { type: 'mrkdwn', text: '(No response)' } }];

    // Convert basic markdown to block kit where possible
    const blocks = [];
    const MAX_BLOCK_LENGTH = 3000;

    // Helper to safely chunk large text blocks
    const addTextBlock = (textArr) => {
      if (textArr.length === 0) return;

      let combined = textArr.join('\n');
      while (combined.length > 0) {
        if (combined.length <= MAX_BLOCK_LENGTH) {
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: combined } });
          break;
        }

        let chunk = combined.substring(0, MAX_BLOCK_LENGTH);
        let splitIdx = chunk.lastIndexOf('\n');
        if (splitIdx < MAX_BLOCK_LENGTH * 0.5) splitIdx = chunk.lastIndexOf(' ');
        if (splitIdx < MAX_BLOCK_LENGTH * 0.5) splitIdx = MAX_BLOCK_LENGTH;

        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: combined.substring(0, splitIdx) } });
        combined = combined.substring(splitIdx).trimStart();
      }
    };

    // Helper to safely chunk large code blocks
    const addCodeBlock = (codeArr) => {
      if (codeArr.length === 0) return;

      let combined = codeArr.join('\n');
      while (combined.length > 0) {
        // Slack limits code blocks as well; deduct length of backticks
        const limit = MAX_BLOCK_LENGTH - 10;
        if (combined.length <= limit) {
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${combined}\n\`\`\`` } });
          break;
        }

        let chunk = combined.substring(0, limit);
        let splitIdx = chunk.lastIndexOf('\n');
        if (splitIdx < limit * 0.5) splitIdx = chunk.lastIndexOf(' ');
        if (splitIdx < limit * 0.5) splitIdx = limit;

        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${combined.substring(0, splitIdx)}\n\`\`\`` } });
        combined = combined.substring(splitIdx).trimStart();
      }
    };

    const lines = text.split('\n');
    let currentTextBlock = [];
    let inCodeBlock = false;
    let currentCodeBlock = [];

    for (const line of lines) {
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          // Close code block
          inCodeBlock = false;
          addTextBlock(currentTextBlock);
          currentTextBlock = [];

          addCodeBlock(currentCodeBlock);
          currentCodeBlock = [];
        } else {
          // Open code block
          inCodeBlock = true;
          // Extract language if present
          const lang = line.slice(3).trim();
          if (lang) currentCodeBlock.push(`// ${lang}`);
        }
      } else {
        if (inCodeBlock) {
          currentCodeBlock.push(line);
        } else {
          currentTextBlock.push(line);
        }
      }
    }

    // Flush any remaining blocks
    if (inCodeBlock) {
      addTextBlock(currentTextBlock);
      addCodeBlock(currentCodeBlock);
    } else {
      addTextBlock(currentTextBlock);
    }

    return blocks;
  }

  async send(target, message, options = {}) {
    if (!this.app) throw new Error('Slack channel not initialized');

    const normalized = this.normalizeTarget(target);
    const channelId = normalized.channelId || normalized.userId;

    if (!channelId) throw new Error('Invalid target: missing channelId or userId');

    const sendOptions = {
      channel: channelId,
      blocks: this.formatResponse(message)
    };

    if (options.threadId) {
      sendOptions.thread_ts = options.threadId;
    }

    await this.app.client.chat.postMessage(sendOptions);
    return { status: 'sent' };
  }

  async handleMessageEvent(event, say, isAppMention) {
    // Ignore bot messages
    if (event.bot_id || event.subtype === 'bot_message') return;

    const isGroup = event.channel_type !== 'im';
    const isReply = !!event.thread_ts;
    const isCommand = event.text && event.text.trim().startsWith('/');
    const wasMentioned = isAppMention || this.hasMention(event.text);

    // Apply mention gating
    if (!shouldRespond({
      isGroup,
      requireMention: this.requireMention,
      wasMentioned,
      isCommand,
      isReply
    })) {
      return;
    }

    // Build standard King Louie message format
    const group = isGroup ? { id: event.channel, channelId: event.channel } : null;
    const sessionKey = SlackChannel.buildSessionKey(event.user, group);

    // Remove mention from text if present
    let text = event.text || '';
    if (this.botUserId) {
      const regex = new RegExp(`<@${this.botUserId}>\\s*`);
      text = text.replace(regex, '').trim();
    }

    const message = {
      channel: 'slack',
      sender: { id: event.user, isGroup },
      group,
      text,
      mentions: wasMentioned ? [this.botUserId] : [],
      attachments: [], // Todo: support slack files
      threadId: event.thread_ts || event.ts,
      raw: event,
      sessionKey
    };

    if (this.gateway) {
      try {
        await this.gateway.routeInbound(message);
      } catch (err) {
        console.error('[slack] error routing message:', err);
        // Fallback error response
        await say({
          text: `Error processing message: ${err.message}`,
          thread_ts: event.thread_ts || event.ts
        });
      }
    }
  }
}

module.exports = SlackChannel;
