const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

class BrowserService {
  constructor(options = {}) {
    this.options = {
      headless: true,
      viewport: { width: 1280, height: 720 },
      userDataPath: path.join(os.tmpdir(), 'king-louie-browser-profile'),
      ...options
    };
    this.process = null;
  }

  detectBrowserPaths() {
    const paths = [];
    const platform = os.platform();

    if (platform === 'win32') {
      const prefixes = [
        process.env.LOCALAPPDATA,
        process.env.PROGRAMFILES,
        process.env['PROGRAMFILES(X86)']
      ];
      for (const prefix of prefixes) {
        if (!prefix) continue;
        paths.push(
          path.join(prefix, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(prefix, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(prefix, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
        );
      }
    } else if (platform === 'darwin') {
      paths.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
      );
    } else {
      paths.push(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
        '/usr/bin/brave-browser'
      );
    }

    return paths.filter(p => fs.existsSync(p));
  }

  getLaunchArgs() {
    const args = [
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${this.options.userDataPath}`,
      `--window-size=${this.options.viewport.width},${this.options.viewport.height}`
    ];

    if (this.options.headless) {
      args.push('--headless=new'); // or just --headless depending on browser version, but =new is standard now
    }

    return args;
  }

  async start() {
    if (this.process) return this.wsUrl;

    const paths = this.detectBrowserPaths();
    if (paths.length === 0) {
      throw new Error('No supported browser found (Chrome, Edge, Brave, Chromium)');
    }

    const browserPath = paths[0];
    const args = this.getLaunchArgs();

    // Ensure user data dir exists
    if (!fs.existsSync(this.options.userDataPath)) {
      fs.mkdirSync(this.options.userDataPath, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      this.process = spawn(browserPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'] // Only read stderr for the WS url
      });

      let stderrOutput = '';
      let wsUrlResolved = false;

      this.process.stderr.on('data', (data) => {
        const text = data.toString();
        stderrOutput += text;

        // CdpClient will parse it
        const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match && !wsUrlResolved) {
          wsUrlResolved = true;
          this.wsUrl = match[1];
          resolve(this.wsUrl);
        }
      });

      this.process.on('error', (err) => {
        if (!wsUrlResolved) reject(err);
        this.process = null;
      });

      this.process.on('close', (code) => {
        if (!wsUrlResolved) {
          reject(new Error(`Browser exited with code ${code}. Stderr: ${stderrOutput}`));
        }
        this.process = null;
      });

      // Timeout just in case
      setTimeout(() => {
        if (!wsUrlResolved) {
          if (this.process) {
            this.process.kill();
            this.process = null;
          }
          reject(new Error('Browser launch timed out waiting for DevTools URL'));
        }
      }, 10000);
    });
  }

  async stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.wsUrl = null;
    }
  }
}

module.exports = BrowserService;
