const { wrapHandler } = require('./wrap-handler');
const constants = require('./constants');

function registerCronHandlers(ipcMain, context) {
  ipcMain.handle(
    constants.CRON_LIST,
    wrapHandler('cron:list', async () => {
      const scheduler = context.getCronScheduler();
      if (!scheduler) throw new Error('Cron scheduler not available');
      return { ok: true, jobs: scheduler.listJobs() };
    })
  );

  ipcMain.handle(
    constants.CRON_ADD,
    wrapHandler('cron:add', async (event, payload) => {
      const scheduler = context.getCronScheduler();
      if (!scheduler) throw new Error('Cron scheduler not available');
      const job = await scheduler.addJob(payload);
      return { ok: true, job };
    })
  );

  ipcMain.handle(
    constants.CRON_UPDATE,
    wrapHandler('cron:update', async (event, payload) => {
      const scheduler = context.getCronScheduler();
      if (!scheduler) throw new Error('Cron scheduler not available');
      const { id, patch } = payload;
      const job = await scheduler.updateJob(id, patch);
      return { ok: true, job };
    })
  );

  ipcMain.handle(
    constants.CRON_REMOVE,
    wrapHandler('cron:remove', async (event, payload) => {
      const scheduler = context.getCronScheduler();
      if (!scheduler) throw new Error('Cron scheduler not available');
      const { id } = payload;
      const removed = await scheduler.removeJob(id);
      return { ok: true, removed };
    })
  );

  ipcMain.handle(
    constants.CRON_RUN,
    wrapHandler('cron:run', async (event, payload) => {
      const scheduler = context.getCronScheduler();
      if (!scheduler) throw new Error('Cron scheduler not available');
      const { id } = payload;
      const result = await scheduler.runNow(id);
      return { ok: true, result };
    })
  );

  ipcMain.handle(
    constants.CRON_STATUS,
    wrapHandler('cron:status', async () => {
      const scheduler = context.getCronScheduler();
      if (!scheduler) throw new Error('Cron scheduler not available');
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
    })
  );
}

module.exports = {
  registerCronHandlers
};
