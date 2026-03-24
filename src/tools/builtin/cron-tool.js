const { Tool } = require('../tool-schema');

const cronTool = new Tool({
  name: 'Cron',
  description: 'Manage cron jobs for scheduled agent executions. Actions: list, add, update, remove, run, status.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'run', 'status'] },
      id: { type: 'string', description: 'Job ID (required for update, remove, run)' },
      job: {
        type: 'object',
        description: 'Job details (required for add, optional for update). Must contain "schedule" and "payload".'
      }
    },
    required: ['action']
  },
  requiresApproval: true,
  execute: async (params, context) => {
    const { action, id, job } = params;
    const scheduler = context?.cronScheduler;

    if (!scheduler) {
      return { ok: false, error: 'Cron scheduler is not available in the current context.' };
    }

    try {
      if (action === 'list') {
        const jobs = scheduler.listJobs();
        return { ok: true, jobs };
      }

      if (action === 'add') {
        if (!job || !job.schedule || !job.payload) {
          return { ok: false, error: 'Job details (schedule and payload) are required for add action.' };
        }
        const created = await scheduler.addJob(job);
        return { ok: true, job: created };
      }

      if (action === 'update') {
        if (!id || !job) {
          return { ok: false, error: 'Job ID and updated details are required for update action.' };
        }
        const updated = await scheduler.updateJob(id, job);
        if (!updated) return { ok: false, error: `Job not found: ${id}` };
        return { ok: true, job: updated };
      }

      if (action === 'remove') {
        if (!id) return { ok: false, error: 'Job ID is required for remove action.' };
        const removed = await scheduler.removeJob(id);
        if (!removed) return { ok: false, error: `Job not found: ${id}` };
        return { ok: true, removed: true };
      }

      if (action === 'run') {
        if (!id) return { ok: false, error: 'Job ID is required for run action.' };
        const result = await scheduler.runNow(id);
        return { ok: result.ok, result };
      }

      if (action === 'status') {
        const jobs = scheduler.listJobs();
        const activeCount = jobs.filter(j => j.enabled).length;
        return {
          ok: true,
          status: {
             running: !!scheduler.timer,
             totalJobs: jobs.length,
             activeJobs: activeCount
          }
        };
      }

      return { ok: false, error: `Unknown action: ${action}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
});

module.exports = cronTool;
