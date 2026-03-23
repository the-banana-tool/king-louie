class NtfyChannel {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || 'https://ntfy.sh').replace(/\/$/, '');
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