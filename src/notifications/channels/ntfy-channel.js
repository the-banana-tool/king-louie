const PRIVATE_HOSTNAME_PATTERN = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i;

class NtfyChannel {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || 'https://ntfy.sh').replace(/\/$/, '');
    if (options.baseUrl) {
      try {
        const parsed = new URL(this.baseUrl);
        if (PRIVATE_HOSTNAME_PATTERN.test(parsed.hostname)) {
          throw new Error(`ntfy baseUrl must not point to a private network: ${parsed.hostname}`);
        }
      } catch (error) {
        if (error.message.includes('private network')) throw error;
        throw new Error(`Invalid ntfy baseUrl: ${this.baseUrl}`);
      }
    }
  }

  async send(payload = {}) {
    const topic = String(payload.topic || '').trim();
    if (!topic) {
      return {
        ok: false,
        skipped: true,
        reason: 'No ntfy topic configured.'
      };
    }

    const title = String(payload.title || 'King Louie');
    const message = String(payload.body || 'Task completed.');

    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        title,
        tags: 'robot,king-louie'
      },
      body: message
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ntfy publish failed: ${response.status} ${response.statusText} ${text}`);
    }

    return {
      ok: true,
      channel: 'ntfy',
      topic
    };
  }
}

module.exports = NtfyChannel;