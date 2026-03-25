const { wrapHandler } = require('./wrap-handler');
const constants = require('./constants');

function registerWizardHandlers(ipcMain, context) {
  ipcMain.handle(
    constants.WIZARD_GET_STATUS,
    wrapHandler('wizard:getStatus', async () => {
      const store = context.getStore();
      if (!store) throw new Error('Store not available');
      const { isFirstRun } = require('../wizard/onboarding-wizard');
      return { ok: true, isFirstRun: isFirstRun(store) };
    })
  );

  ipcMain.handle(
    constants.WIZARD_COMPLETE,
    wrapHandler('wizard:complete', async () => {
      const store = context.getStore();
      if (!store) throw new Error('Store not available');
      const { completeOnboarding } = require('../wizard/onboarding-wizard');
      completeOnboarding(store);
      return { ok: true };
    })
  );

  ipcMain.handle(
    constants.WIZARD_GET_STEPS,
    wrapHandler('wizard:getSteps', async () => {
      const { getWizardSteps } = require('../wizard/onboarding-wizard');
      const steps = getWizardSteps();
      return { ok: true, steps: steps.map(s => ({ id: s.id, title: s.title, description: s.description, optional: s.optional })) };
    })
  );
}

module.exports = { registerWizardHandlers };
