const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerWebhookHandlers(ipcMain, context = {}) {
  const { webhookRegistry, webhookServer } = context;

  if (!webhookRegistry) {
    console.warn('[webhook-handlers] webhookRegistry not available in context');
    return;
  }

  ipcMain.handle(IPC.WEBHOOK_LIST, wrapHandler(IPC.WEBHOOK_LIST, async () => {
    return webhookRegistry.list();
  }));

  ipcMain.handle(IPC.WEBHOOK_CREATE, wrapHandler(IPC.WEBHOOK_CREATE, async (_event, payload) => {
    const { name, messageTemplate, rateLimit, route, signatureFormat } = payload;
    
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new Error('Webhook name is required');
    }

    const config = {
      name: name.trim(),
      messageTemplate: messageTemplate || 'Webhook received: {{body}}',
      rateLimit: rateLimit || { maxPerMinute: 60 },
      route: route || { sessionTarget: 'main' },
      signatureFormat: signatureFormat || 'sha256'
    };

    const webhook = webhookRegistry.register(config);
    
    return {
      ...webhook,
      url: webhookServer ? webhookServer.getWebhookUrl(webhook.id) : null
    };
  }));

  ipcMain.handle(IPC.WEBHOOK_UPDATE, wrapHandler(IPC.WEBHOOK_UPDATE, async (_event, payload) => {
    const { id, ...updates } = payload;
    
    if (!id || typeof id !== 'string') {
      throw new Error('Webhook ID is required');
    }

    const webhook = webhookRegistry.update(id, updates);
    if (!webhook) {
      throw new Error(`Webhook not found: ${id}`);
    }

    return {
      ...webhook,
      url: webhookServer ? webhookServer.getWebhookUrl(webhook.id) : null
    };
  }));

  ipcMain.handle(IPC.WEBHOOK_DELETE, wrapHandler(IPC.WEBHOOK_DELETE, async (_event, payload) => {
    const { id } = payload;
    
    if (!id || typeof id !== 'string') {
      throw new Error('Webhook ID is required');
    }

    const success = webhookRegistry.unregister(id);
    if (!success) {
      throw new Error(`Webhook not found: ${id}`);
    }

    return { success: true };
  }));

  ipcMain.handle(IPC.WEBHOOK_GET, wrapHandler(IPC.WEBHOOK_GET, async (_event, payload) => {
    const { id } = payload;
    
    if (!id || typeof id !== 'string') {
      throw new Error('Webhook ID is required');
    }

    const webhook = webhookRegistry.get(id);
    if (!webhook) {
      throw new Error(`Webhook not found: ${id}`);
    }

    return {
      ...webhook,
      url: webhookServer ? webhookServer.getWebhookUrl(webhook.id) : null
    };
  }));

  ipcMain.handle(IPC.WEBHOOK_REGENERATE_SECRET, wrapHandler(IPC.WEBHOOK_REGENERATE_SECRET, async (_event, payload) => {
    const { id } = payload;
    
    if (!id || typeof id !== 'string') {
      throw new Error('Webhook ID is required');
    }

    const webhook = webhookRegistry.get(id);
    if (!webhook) {
      throw new Error(`Webhook not found: ${id}`);
    }

    const newSecret = webhookRegistry.generateSecret();
    const updatedWebhook = webhookRegistry.update(id, { secret: newSecret });

    return {
      ...updatedWebhook,
      url: webhookServer ? webhookServer.getWebhookUrl(updatedWebhook.id) : null
    };
  }));
}

module.exports = { registerWebhookHandlers };