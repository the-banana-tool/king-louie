const { createLogger } = require('../logging');

const log = createLogger('ipc');

function wrapHandler(name, fn) {
  return async (event, ...args) => {
    try {
      const result = await fn(event, ...args);
      if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
        return result;
      }

      return {
        ok: true,
        data: result
      };
    } catch (error) {
      const message = error?.message || String(error || 'Unknown IPC error');
      // A caught error with a code (ProfileError and friends) is a refusal
      // the caller named on purpose — worth a warn, not an error — and the
      // code travels to the renderer so it can tell one refusal from
      // another (e.g. STALE_PROPOSAL) instead of matching on message text.
      const code = typeof error?.code === 'string' && error.code ? error.code : null;
      // A Node system error (ENOENT, ERR_…) also has a code, but is a real
      // failure: it keeps error-level logging.
      const systemError = Boolean(error?.syscall) || (code || '').startsWith('ERR_');
      if (code && !systemError) {
        log.warn(`${name} refused (${code}): ${message}`);
        return { ok: false, error: message, code };
      }
      if (code) {
        log.error(`${name} failed (${code}): ${message}`);
        return { ok: false, error: message, code };
      }
      log.error(`${name} failed: ${message}`);
      return { ok: false, error: message };
    }
  };
}

module.exports = {
  wrapHandler
};