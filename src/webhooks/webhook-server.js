const http = require('http');
const { URL } = require('url');

class WebhookServer {
  constructor(gatewayServer, webhookHandler) {
    this.gatewayServer = gatewayServer;
    this.webhookHandler = webhookHandler;
    this.httpServer = null;
    this._configuredPort = null;
  }

  get port() {
    // Derive from gateway's actual port (which may change after start when using port 0)
    if (this._configuredPort != null) return this._configuredPort;
    return this.gatewayServer.port + 1;
  }

  async start() {
    if (this.httpServer) return;
    // When gateway uses port 0, use port 0 for webhook too
    const listenPort = this.gatewayServer.port === 0 ? 0 : this.port;

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    await new Promise((resolve, reject) => {
      this.httpServer.listen(listenPort, '127.0.0.1', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Update port to the actual bound port (important when using port 0)
    const addr = this.httpServer.address();
    if (addr) this._configuredPort = addr.port;

    console.log(`[webhook-server] HTTP server listening on http://127.0.0.1:${this.port}`);
  }

  async stop() {
    if (!this.httpServer) return;

    await new Promise((resolve) => {
      this.httpServer.close(resolve);
    });
    this.httpServer = null;
  }

  async handleHttpRequest(req, res) {
    // Set CORS headers for development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hub-Signature, X-Hub-Signature-256');

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      
      // Route webhook requests: POST /webhooks/{webhookId}
      const webhookMatch = url.pathname.match(/^\/webhooks\/([a-f0-9]+)$/);
      if (webhookMatch && req.method === 'POST') {
        const webhookId = webhookMatch[1];
        await this.handleWebhookRequest(req, res, webhookId);
        return;
      }

      // Health check endpoint
      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (error) {
      console.error('[webhook-server] Request handling error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  async handleWebhookRequest(req, res, webhookId) {
    try {
      // Read request body
      const body = await this.readRequestBody(req);
      
      // Prepare request object for handler
      const request = {
        body,
        headers: req.headers,
        method: req.method,
        url: req.url,
        ip: req.connection.remoteAddress
      };

      // Process webhook
      const result = await this.webhookHandler.handle(webhookId, request);

      // Send success response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));

    } catch (error) {
      console.error(`[webhook-server] Webhook ${webhookId} processing error:`, error.message);
      
      // Determine appropriate error code
      let statusCode = 500;
      if (error.message.includes('not found')) statusCode = 404;
      else if (error.message.includes('disabled')) statusCode = 410;
      else if (error.message.includes('signature')) statusCode = 401;
      else if (error.message.includes('rate limit')) statusCode = 429;
      else if (error.message.includes('too large')) statusCode = 413;
      else if (error.message.includes('Invalid JSON')) statusCode = 400;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: error.message,
        webhookId,
        timestamp: new Date().toISOString()
      }));
    }
  }

  async readRequestBody(req, maxSize = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;

      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxSize) {
          reject(new Error('Request body too large'));
          return;
        }
        body += chunk.toString();
      });

      req.on('end', () => {
        resolve(body);
      });

      req.on('error', reject);
    });
  }

  getWebhookUrl(webhookId) {
    return `http://127.0.0.1:${this.port}/webhooks/${webhookId}`;
  }
}

module.exports = WebhookServer;