const { formatSuccess } = require('../utils/formatter');

const pendingLogins = new Map();
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function formatApiFailure(error, { prefix = 'Login failed' } = {}) {
  const classification = error?.classification;

  if (classification === 'auth_invalid') {
    return `${prefix}: Authentication failed (401). Your username/password were rejected.\nTip: Verify credentials and confirm the API base URL matches the server expecting Basic Auth.`;
  }

  if (classification === 'auth_forbidden') {
    return `${prefix}: Authentication succeeded but access was denied (403). Your account likely lacks permission for this endpoint.`;
  }

  if (classification === 'endpoint_not_found') {
    return `${prefix}: API endpoint not found (404). Check your base URL (for example ensure /api/v1 is included).`;
  }

  if (classification === 'network_timeout') {
    return `${prefix}: API timed out. The server may be slow/unreachable or timeout is too low.`;
  }

  if (classification === 'network_error') {
    return `${prefix}: Could not reach the API server. Check URL, network, DNS, and whether the API is running.`;
  }

  return `${prefix}: ${error?.message || 'Unknown API error.'}`;
}

function getSessionKey(commandContext = {}) {
  if (commandContext?.session?.key) return commandContext.session.key;

  const channel = commandContext?.channel || 'unknown';
  const chatId = commandContext?.chatId || commandContext?.userId || 'default';
  return `${channel}:${chatId}`;
}

function getInput(args = []) {
  return String(args.join(' ') || '').trim();
}

function isExpired(state) {
  return !state || Date.now() - state.updatedAt > LOGIN_TIMEOUT_MS;
}

function hasPendingLogin(commandContext = {}) {
  const sessionKey = getSessionKey(commandContext);
  const state = pendingLogins.get(sessionKey);
  if (isExpired(state)) {
    pendingLogins.delete(sessionKey);
    return false;
  }

  return Boolean(state);
}

/**
 * Interactive login flow:
 *   /std login
 *   /std login <username>
 *   /std login <password>
 */
async function loginCommand(args, database, context, commandContext) {
  const sessionKey = getSessionKey(commandContext);
  const input = getInput(args);
  const normalized = input.toLowerCase();

  if (normalized === 'cancel') {
    pendingLogins.delete(sessionKey);
    return {
      ok: true,
      message: '✅ Login flow cancelled.'
    };
  }

  let state = pendingLogins.get(sessionKey);
  if (isExpired(state)) {
    pendingLogins.delete(sessionKey);
    state = null;
  }

  if (!state) {
    if (input) {
      pendingLogins.set(sessionKey, {
        step: 'password',
        username: input,
        updatedAt: Date.now()
      });

      return {
        ok: true,
        message:
          '👤 Username received.\n\nNow enter your password with:\n/std login <password>\n\n(Use `/std login cancel` to cancel.)'
      };
    }

    pendingLogins.set(sessionKey, {
      step: 'username',
      updatedAt: Date.now()
    });

    return {
      ok: true,
      message:
        '🔐 STD API Login started.\n\nPlease enter your username with:\n/std login <username>\n\n(Type `/std login cancel` to cancel.)'
    };
  }

  if (state.step === 'username') {
    if (!input) {
      return {
        ok: true,
        message: 'Please enter your username with: /std login <username>'
      };
    }

    state.username = input;
    state.step = 'password';
    state.updatedAt = Date.now();
    pendingLogins.set(sessionKey, state);

    return {
      ok: true,
      message:
        '👤 Username received.\n\nNow enter your password with:\n/std login <password>\n(or just reply with your password)\n\n(Use `/std login cancel` to cancel.)'
    };
  }

  if (state.step === 'password') {
    if (!input) {
      return {
        ok: true,
        message: 'Please enter your password with: /std login <password>'
      };
    }

    pendingLogins.delete(sessionKey);

    try {
      await database.configureApi({
        username: state.username,
        password: input
      });

      try {
        await database.testApiConnection();
        return {
          ok: true,
          message: `${formatSuccess('Logged into STD API successfully.')}\n\nRun /std api status to review your current configuration.`
        };
      } catch (testError) {
        await database.clearApiConfig();
        return {
          ok: false,
          error: `${formatApiFailure(testError)}\n\nCredentials were not kept. Please try /std login again.`
        };
      }
    } catch (error) {
      return {
        ok: false,
        error: `Failed to save login credentials: ${error.message}`
      };
    }
  }

  pendingLogins.delete(sessionKey);
  return {
    ok: false,
    error: 'Login flow reset. Please run /std login again.'
  };
}

loginCommand.hasPendingLogin = hasPendingLogin;

module.exports = loginCommand;