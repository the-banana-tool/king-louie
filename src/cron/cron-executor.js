class CronExecutor {
  constructor({ agentExecutor, sessionManager, channelRegistry }) {
    this.agentExecutor = agentExecutor;
    this.sessionManager = sessionManager;
    this.channelRegistry = channelRegistry;
  }

  async execute(job) {
    if (!job || !job.payload || !job.payload.message) {
      throw new Error('Invalid job payload: missing message');
    }

    try {
      // 1. Create or reuse session
      let session;
      const targetSessionId = job.payload.sessionTarget;

      if (targetSessionId) {
        session = this.sessionManager.getSession(targetSessionId);
        if (!session) {
          throw new Error(`Target session ${targetSessionId} not found`);
        }
      } else {
        // Create an isolated session for this job
        session = this.sessionManager.createSession('cron_isolated', 'cron');
      }

      // 2. Run agent turn
      const turnResult = await this.agentExecutor.executeTurn(session, {
        role: 'user',
        content: job.payload.message
      });

      const responseText = turnResult.message?.content || turnResult.text || '';

      // 3 & 4. Deliver result if channel specified
      if (job.delivery && job.delivery.channelId && this.channelRegistry) {
        const channel = this.channelRegistry.getChannel(job.delivery.channelId);
        if (channel && typeof channel.deliver === 'function') {
          await channel.deliver(job.delivery.targetId, responseText);
        } else if (channel && typeof channel.sendMessage === 'function') {
           await channel.sendMessage(job.delivery.targetId, responseText);
        } else {
          console.warn(`Channel ${job.delivery.channelId} not found or delivery method missing`);
        }
      }

      // 5. Update state
      job.state = job.state || {};
      job.state.lastRunAtMs = Date.now();
      job.state.lastResult = 'success';
      job.state.consecutiveErrors = 0;

      return { ok: true, result: responseText };

    } catch (error) {
      job.state = job.state || {};
      job.state.lastRunAtMs = Date.now();
      job.state.lastResult = 'error';
      job.state.lastError = error.message;
      job.state.consecutiveErrors = (job.state.consecutiveErrors || 0) + 1;

      throw error;
    }
  }
}

module.exports = CronExecutor;
