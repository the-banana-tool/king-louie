const { createLogger } = require('../logging');

const log = createLogger('cron-executor');

class CronExecutor {
  constructor(agentExecutor, sessionManager, gateway) {
    this.agentExecutor = agentExecutor;
    this.sessionManager = sessionManager;
    this.gateway = gateway;
  }

  async execute(job) {
    if (!job || !job.payload) {
      throw new Error('Invalid job payload');
    }

    const { sessionTarget, message } = job.payload;
    if (!message) {
      throw new Error('Job payload missing message');
    }

    // Determine session key
    const sessionKey = sessionTarget || `cron:local:${job.id}`;

    // Get or create session
    let session = this.sessionManager.getSession(sessionKey);
    if (!session) {
      session = this.sessionManager.createSession(sessionKey, {
        source: 'cron',
        jobId: job.id
      });
    }

    // Run agent turn
    const agent = this.gateway.getAgent('main'); // Use main agent by default
    if (!agent) {
      throw new Error('Main agent not found for cron execution');
    }

    try {
      const result = await this.agentExecutor.execute(agent, message, {
        sessionKey,
        runId: `run_${Date.now()}`
      });

      // Deliver to configured channel if specified
      if (job.delivery) {
        if (this.gateway.channelRegistry) {
          const channel = this.gateway.channelRegistry.get(job.delivery.channel);
          if (channel) {
            await channel.send(job.delivery.target, result.content);
          } else {
             log.warn(`delivery channel not found: ${job.delivery.channel}`);
          }
        } else {
             log.warn('gateway channelRegistry not available');
        }
      }

      return {
        ok: true,
        content: result.content
      };
    } catch (err) {
      log.error(`execution failed for job ${job.id}: ${err.message}`);
      return {
        ok: false,
        error: err.message
      };
    }
  }
}

module.exports = CronExecutor;
