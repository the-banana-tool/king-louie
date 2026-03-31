const crypto = require('crypto');
const http = require('http');
const { shell } = require('electron');

const ANTHROPIC_AUTH_URL = 'https://console.anthropic.com/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/oauth/token';
const CALLBACK_PORT = 17483;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const SCOPES = 'user:inference';

class AnthropicOAuth {
  constructor({ clientId, encryptToken, decryptToken, store }) {
    this.clientId = clientId;
    this.encryptToken = encryptToken;
    this.decryptToken = decryptToken;
    this.store = store;
    this._server = null;
    this._pendingResolve = null;
    this._pendingReject = null;
  }

  /**
   * Generate PKCE code verifier and challenge.
   */
  _generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
    return { verifier, challenge };
  }

  /**
   * Start the OAuth flow: open browser, wait for callback.
   * Returns { accessToken, refreshToken, expiresAt }.
   */
  async startAuthFlow() {
    if (this._server) {
      throw new Error('OAuth flow already in progress.');
    }

    const { verifier, challenge } = this._generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    });

    const authUrl = `${ANTHROPIC_AUTH_URL}?${params.toString()}`;

    const codePromise = new Promise((resolve, reject) => {
      this._pendingResolve = resolve;
      this._pendingReject = reject;

      this._server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);

        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const error = url.searchParams.get('error');
        if (error) {
          const desc = url.searchParams.get('error_description') || error;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(this._errorPage(desc));
          reject(new Error(`OAuth error: ${desc}`));
          this._cleanup();
          return;
        }

        const returnedState = url.searchParams.get('state');
        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(this._errorPage('State mismatch. Please try again.'));
          reject(new Error('OAuth state mismatch.'));
          this._cleanup();
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(this._errorPage('No authorization code received.'));
          reject(new Error('No authorization code received.'));
          this._cleanup();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(this._successPage());
        resolve(code);
        this._cleanup();
      });

      this._server.listen(CALLBACK_PORT, '127.0.0.1', () => {
        shell.openExternal(authUrl);
      });

      this._server.on('error', (err) => {
        reject(new Error(`Failed to start callback server: ${err.message}`));
        this._cleanup();
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this._pendingReject) {
          reject(new Error('OAuth flow timed out. Please try again.'));
          this._cleanup();
        }
      }, 5 * 60 * 1000);
    });

    const code = await codePromise;
    return this._exchangeCode(code, verifier);
  }

  /**
   * Exchange authorization code for tokens.
   */
  async _exchangeCode(code, verifier) {
    const response = await fetch(ANTHROPIC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      }).toString()
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${body}`);
    }

    const data = await response.json();
    return this._processTokenResponse(data);
  }

  /**
   * Refresh the access token using the stored refresh token.
   */
  async refreshAccessToken() {
    const oauthData = this._getStoredOAuth();
    if (!oauthData?.refreshToken) {
      throw new Error('No refresh token available. Please sign in again.');
    }

    const refreshToken = this.decryptToken(oauthData.refreshToken);

    const response = await fetch(ANTHROPIC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        refresh_token: refreshToken
      }).toString()
    });

    if (!response.ok) {
      const body = await response.text();
      // If refresh fails, clear stored tokens so user can re-auth
      if (response.status === 401 || response.status === 400) {
        this.clearStoredTokens();
      }
      throw new Error(`Token refresh failed (${response.status}): ${body}`);
    }

    const data = await response.json();
    return this._processTokenResponse(data);
  }

  /**
   * Get a valid access token, refreshing if needed.
   */
  async getValidAccessToken() {
    const oauthData = this._getStoredOAuth();
    if (!oauthData?.accessToken) {
      throw new Error('Not signed in to Anthropic. Please use OAuth to sign in.');
    }

    // Refresh if token expires within the next 60 seconds
    const now = Date.now();
    if (oauthData.expiresAt && now >= oauthData.expiresAt - 60_000) {
      const refreshed = await this.refreshAccessToken();
      return refreshed.accessToken;
    }

    return this.decryptToken(oauthData.accessToken);
  }

  /**
   * Process token response and store encrypted tokens.
   */
  _processTokenResponse(data) {
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;
    const expiresIn = data.expires_in || 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    if (!accessToken) {
      throw new Error('No access token in response.');
    }

    const oauthData = {
      accessToken: this.encryptToken(accessToken),
      refreshToken: refreshToken ? this.encryptToken(refreshToken) : this._getStoredOAuth()?.refreshToken || null,
      expiresAt,
      connectedAt: Date.now()
    };

    this.store.set('anthropicOAuth', oauthData);

    return {
      accessToken,
      expiresAt,
      hasRefreshToken: Boolean(oauthData.refreshToken)
    };
  }

  /**
   * Check if the user has an active OAuth connection.
   */
  isConnected() {
    const oauthData = this._getStoredOAuth();
    return Boolean(oauthData?.accessToken);
  }

  /**
   * Get stored OAuth status (without exposing tokens).
   */
  getStatus() {
    const oauthData = this._getStoredOAuth();
    if (!oauthData?.accessToken) {
      return { connected: false };
    }

    const now = Date.now();
    const expired = oauthData.expiresAt ? now >= oauthData.expiresAt : false;

    return {
      connected: true,
      expired,
      expiresAt: oauthData.expiresAt || null,
      connectedAt: oauthData.connectedAt || null,
      hasRefreshToken: Boolean(oauthData.refreshToken)
    };
  }

  /**
   * Clear stored OAuth tokens (sign out).
   */
  clearStoredTokens() {
    this.store.delete('anthropicOAuth');
  }

  /**
   * Cancel any in-progress OAuth flow.
   */
  cancel() {
    if (this._pendingReject) {
      this._pendingReject(new Error('OAuth flow cancelled.'));
    }
    this._cleanup();
  }

  _getStoredOAuth() {
    return this.store.get('anthropicOAuth', null);
  }

  _cleanup() {
    this._pendingResolve = null;
    this._pendingReject = null;
    if (this._server) {
      try { this._server.close(); } catch { /* ignore */ }
      this._server = null;
    }
  }

  _successPage() {
    return `<!DOCTYPE html>
<html><head><title>Signed In</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex; justify-content: center; align-items: center; height: 100vh;
    margin: 0; background: #1a1a2e; color: #e0e0e0; }
  .card { text-align: center; padding: 2rem; border-radius: 12px;
    background: #16213e; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
  h1 { color: #d4a574; margin-bottom: 0.5rem; }
  p { color: #a0a0b0; }
</style></head>
<body><div class="card">
  <h1>Signed in successfully</h1>
  <p>You can close this tab and return to King Louie.</p>
</div></body></html>`;
  }

  _errorPage(message) {
    return `<!DOCTYPE html>
<html><head><title>Sign In Failed</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex; justify-content: center; align-items: center; height: 100vh;
    margin: 0; background: #1a1a2e; color: #e0e0e0; }
  .card { text-align: center; padding: 2rem; border-radius: 12px;
    background: #16213e; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
  h1 { color: #e74c3c; margin-bottom: 0.5rem; }
  p { color: #a0a0b0; }
</style></head>
<body><div class="card">
  <h1>Sign in failed</h1>
  <p>${message}</p>
</div></body></html>`;
  }
}

module.exports = AnthropicOAuth;
