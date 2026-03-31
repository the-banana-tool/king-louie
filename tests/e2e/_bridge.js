/**
 * Test bridge — injected into King Louie's main process via app.on('ready').
 * Starts an HTTP server that accepts requests to evaluate JS in the renderer.
 *
 * Activated when KL_TEST_BRIDGE_PORT is set in the environment.
 */
const http = require('http');
const { app, BrowserWindow } = require('electron');

const port = parseInt(process.env.KL_TEST_BRIDGE_PORT, 10);
if (!port) process.exit(0); // Not in test mode

function getMainWindow() {
  const wins = BrowserWindow.getAllWindows();
  return wins[0] || null;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.url === '/ping') {
      const win = getMainWindow();
      res.end(JSON.stringify({ ok: true, hasWindow: !!win }));
      return;
    }

    if (req.url === '/quit') {
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => app.quit(), 100);
      return;
    }

    if (req.url === '/eval' && req.method === 'POST') {
      const body = await readBody(req);
      const { code } = JSON.parse(body);
      const win = getMainWindow();
      if (!win || win.isDestroyed()) {
        res.end(JSON.stringify({ error: 'No window available' }));
        return;
      }

      try {
        const result = await win.webContents.executeJavaScript(code, true);
        res.end(JSON.stringify({ result }));
      } catch (err) {
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.url === '/window-info') {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) {
        res.end(JSON.stringify({ error: 'No window' }));
        return;
      }
      res.end(JSON.stringify({
        title: win.getTitle(),
        visible: win.isVisible(),
        focused: win.isFocused(),
        size: win.getSize(),
        url: win.webContents.getURL()
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

// App is already ready (loaded inside app.whenReady in main.js)
// Use port 0 to let the OS pick a free port, then write it to stdout for the harness
server.listen(0, '127.0.0.1', () => {
  const actualPort = server.address().port;
  process.stdout.write(`KL_BRIDGE_PORT=${actualPort}\n`);
});

app.on('will-quit', () => {
  try { server.close(); } catch { /* ok */ }
});
