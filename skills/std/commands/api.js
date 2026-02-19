const { parseArgs } = require('../utils/parser');
const { formatSuccess } = require('../utils/formatter');

function formatApiFailure(error, { prefix = 'API test failed' } = {}) {
  const classification = error?.classification;

  if (classification === 'auth_invalid') {
    return `${prefix}: Authentication failed (401). Username/password were rejected.\nTip: Verify credentials and confirm this API endpoint expects Basic Auth.`;
  }

  if (classification === 'auth_forbidden') {
    return `${prefix}: Authentication succeeded but access is forbidden (403). Check account permissions.`;
  }

  if (classification === 'endpoint_not_found') {
    return `${prefix}: Endpoint not found (404). Check your base URL (for example include /api/v1 if required).`;
  }

  if (classification === 'network_timeout') {
    return `${prefix}: Request timed out. Server may be slow/unreachable or timeout is too low.`;
  }

  if (classification === 'network_error') {
    return `${prefix}: Could not reach API server. Check URL, network, DNS, and server status.`;
  }

  return `${prefix}: ${error?.message || 'Unknown API error.'}`;
}

function maskUsername(username) {
  if (!username) return 'not set';
  if (username.length <= 2) return `${username[0]}*`;
  return `${username[0]}${'*'.repeat(Math.max(1, username.length - 2))}${username[username.length - 1]}`;
}

function formatApiStatus(status) {
  return [
    '🌐 STD API Configuration',
    '',
    `Mode: ${status.remoteMode ? 'Remote API' : 'Local database'}`,
    `Base URL: ${status.baseUrl}`,
    `Credentials: ${status.hasCredentials ? 'configured' : 'not configured'}`,
    `Username: ${maskUsername(status.username)}`,
    `Timeout: ${status.timeoutMs}ms`
  ].join('\n');
}

function getHelpText() {
  return [
    '🌐 STD API Commands',
    '',
    '  /std api status',
    '    Show current API/local mode and config status',
    '',
    '  /std api set --username <user> --password <pass> [--url <baseUrl>] [--timeout <ms>]',
    '    Save API credentials and enable remote mode',
    '',
    '  /std api test',
    '    Test connectivity/auth against the configured API',
    '',
    '  /std api clear',
    '    Remove saved API credentials and switch back to local database',
    '',
    'Examples:',
    '  /std api set --username seth --password mySecret --url https://www.sethserver.com/api/v1',
    '  /std api status',
    '  /std api test',
    '  /std api clear'
  ].join('\n');
}

async function apiCommand(args, database) {
  const parsed = parseArgs(args);
  const subcommand = (parsed.positional[0] || 'help').toLowerCase();

  if (subcommand === 'help') {
    return { ok: true, message: getHelpText() };
  }

  if (subcommand === 'status') {
    return { ok: true, message: formatApiStatus(database.getApiStatus()) };
  }

  if (subcommand === 'set') {
    const username = parsed.flags.username || parsed.flags.user || parsed.positional[1];
    const password = parsed.flags.password || parsed.flags.pass || parsed.positional[2];
    const baseUrl = parsed.flags.url || parsed.flags.baseUrl;
    const timeout = parsed.flags.timeout;

    if (!username || !password) {
      return {
        ok: false,
        error: 'Usage: /std api set --username <user> --password <pass> [--url <baseUrl>] [--timeout <ms>]'
      };
    }

    const status = await database.configureApi({
      username,
      password,
      baseUrl,
      timeoutMs: timeout
    });

    return {
      ok: true,
      message: `${formatSuccess('STD API config saved. Remote mode enabled.')}\n\n${formatApiStatus(status)}`
    };
  }

  if (subcommand === 'test') {
    try {
      const result = await database.testApiConnection();
      if (!result.ok) {
        return { ok: false, error: result.message };
      }

      return { ok: true, message: formatSuccess(result.message) };
    } catch (error) {
      return {
        ok: false,
        error: formatApiFailure(error)
      };
    }
  }

  if (subcommand === 'clear' || subcommand === 'disable') {
    const status = await database.clearApiConfig();
    return {
      ok: true,
      message: `${formatSuccess('Cleared API credentials. Switched back to local database mode.')}\n\n${formatApiStatus(status)}`
    };
  }

  return {
    ok: false,
    error: `Unknown API subcommand: ${subcommand}. Use: /std api help`
  };
}

module.exports = apiCommand;