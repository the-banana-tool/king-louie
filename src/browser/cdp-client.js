const WebSocket = require('ws');
const crypto = require('crypto');

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.messageId = 1;
    this.pendingResolvers = new Map();
    this.eventListeners = new Map();
    this.consoleMessages = [];
  }

  static parseWsUrl(stderr) {
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    return match ? match[1] : null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (err) {
        return reject(err);
      }

      const timeout = setTimeout(() => {
        if (this.ws) this.ws.close();
        reject(new Error('CDP WebSocket connection timed out'));
      }, 10000);

      this.ws.on('open', async () => {
        clearTimeout(timeout);

        // Setup console listening automatically when connected
        try {
          await this.send('Runtime.enable');
          this.on('Runtime.consoleAPICalled', (params) => {
            const type = params.type;
            const args = params.args.map(a => a.value !== undefined ? a.value : a.description).join(' ');
            this.consoleMessages.push({ type, text: args, timestamp: params.timestamp });
          });
        } catch (e) {
          console.error('[CdpClient] Failed to enable Runtime for console logs', e);
        }

        resolve();
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.id && this.pendingResolvers.has(msg.id)) {
            const { resolve, reject } = this.pendingResolvers.get(msg.id);
            this.pendingResolvers.delete(msg.id);
            if (msg.error) {
              reject(new Error(`CDP Error (${msg.error.code}): ${msg.error.message}`));
            } else {
              resolve(msg.result);
            }
          } else if (msg.method) {
            this.emit(msg.method, msg.params);
          }
        } catch (err) {
          console.error('[CdpClient] Error parsing message:', err);
        }
      });

      this.ws.on('close', () => {
        for (const { reject } of this.pendingResolvers.values()) {
          reject(new Error('WebSocket closed before response received'));
        }
        this.pendingResolvers.clear();
      });
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    const id = this.messageId++;
    return new Promise((resolve, reject) => {
      this.pendingResolvers.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          this.pendingResolvers.delete(id);
          reject(err);
        }
      });
    });
  }

  on(method, callback) {
    if (!this.eventListeners.has(method)) {
      this.eventListeners.set(method, new Set());
    }
    this.eventListeners.get(method).add(callback);
  }

  off(method, callback) {
    if (this.eventListeners.has(method)) {
      this.eventListeners.get(method).delete(callback);
    }
  }

  emit(method, params) {
    if (this.eventListeners.has(method)) {
      for (const callback of this.eventListeners.get(method)) {
        try {
          callback(params);
        } catch (err) {
          console.error(`[CdpClient] Error in event listener for ${method}:`, err);
        }
      }
    }
  }

  async navigate(url) {
    await this.send('Page.enable');
    const result = await this.send('Page.navigate', { url });

    // Wait for load event
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('Page.loadEventFired', onLoaded);
        resolve({ error: 'Navigation timed out, but page may have loaded' });
      }, 30000);

      const onLoaded = () => {
        clearTimeout(timeout);
        this.off('Page.loadEventFired', onLoaded);
        resolve(result);
      };

      this.on('Page.loadEventFired', onLoaded);
    });
  }

  async screenshot() {
    await this.send('Page.enable');
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    return data;
  }

  async pdf() {
    await this.send('Page.enable');
    const { data } = await this.send('Page.printToPDF', { printBackground: true });
    return data;
  }

  async evaluate(expression) {
    await this.send('Runtime.enable');
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${result.exceptionDetails.exception.description || result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async click(selector) {
    // We evaluate a script to click the element
    const expression = `
      (() => {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!el) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}');
        el.click();
        return true;
      })()
    `;
    return this.evaluate(expression);
  }

  async type(selector, text) {
    const expression = `
      (() => {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!el) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}');
        el.focus();
        // Set value directly for simplicity, though not perfect for all inputs
        if ('value' in el) {
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = ${JSON.stringify(text)};
        }
        return true;
      })()
    `;
    return this.evaluate(expression);
  }

  async waitForSelector(selector, timeout = 30000) {
    const expression = `
      new Promise((resolve, reject) => {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (el) return resolve(true);

        const observer = new MutationObserver(() => {
          if (document.querySelector('${selector.replace(/'/g, "\\'")}')) {
            observer.disconnect();
            resolve(true);
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => {
          observer.disconnect();
          reject(new Error('Timeout waiting for selector: ${selector.replace(/'/g, "\\'")}'));
        }, ${timeout});
      })
    `;
    return this.evaluate(expression);
  }
}

module.exports = CdpClient;
