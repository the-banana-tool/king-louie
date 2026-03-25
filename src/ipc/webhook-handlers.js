const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerWebhookHandlers(ipcMain, context = {}) {
  const getRegistry = () => context.getWebhookRegistry ? context.getWebhookRegistry() : context.webhookRegistry;
  const getServer = () => context.getWebhookServer ? context.getWebhookServer() : context.webhookServer;

  const requireRegistry = () => {
    const registry = getRegistry();
    if (!registry) throw new Error('Webhook system is still initializing, please try again');
    return registry;
  };

  ipcMain.handle(IPC.WEBHOOK_LIST, wrapHandler(IPC.WEBHOOK_LIST, async () => {
    const registry = getRegistry();
    if (!registry) return [];
    return registry.list();
  }));

  ipcMain.handle(IPC.WEBHOOK_CREATE, wrapHandler(IPC.WEBHOOK_CREATE, async (_event, payload) => {
    const webhookRegistry = requireRegistry();
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
    const webhookServer = getServer();

    return {
      ...webhook,
      url: webhookServer ? webhookServer.getWebhookUrl(webhook.id) : null
    };
  }));

  ipcMain.handle(IPC.WEBHOOK_UPDATE, wrapHandler(IPC.WEBHOOK_UPDATE, async (_event, payload) => {
    const webhookRegistry = requireRegistry();
    const { id, ...updates } = payload;

    if (!id || typeof id !== 'string') {
      throw new Error('Webhook ID is required');
    }

    const webhook = webhookRegistry.update(id, updates);
    if (!webhook) {
      throw new Error(`Webhook not found: ${id}`);
    }

    const webhookServer = getServer();
    return {
      ...webhook,
      url: webhookServer ? webhookServer.getWebhookUrl(webhook.id) : null
    };
  }));

  ipcMain.handle(IPC.WEBHOOK_DELETE, wrapHandler(IPC.WEBHOOK_DELETE, async (_event, payload) => {
    const webhookRegistry = requireRegistry();
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
    const webhookRegistry = requireRegistry();
    const { id } = payload;

    if (!id || typeof id !== 'string') {
      throw new Error('Webhook ID is required');
    }

    const webhook = webhookRegistry.get(id);
    if (!webhook) {
      throw new Error(`Webhook not found: ${id}`);
    }

    const webhookServer = getServer();
    return {
      ...webhook,
      url: webhookServer ? webhookServer.getWebhookUrl(webhook.id) : null
    };
  }));

  ipcMain.handle(IPC.WEBHOOK_REGENERATE_SECRET, wrapHandler(IPC.WEBHOOK_REGENERATE_SECRET, async (_event, payload) => {
    const webhookRegistry = requireRegistry();
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

    const webhookServer = getServer();
    return {
      ...updatedWebhook,
      url: webhookServer ? webhookServer.getWebhookUrl(updatedWebhook.id) : null
    };
  }));
}

module.exports = { registerWebhookHandlers };
