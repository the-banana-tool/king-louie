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
      console.error(`[ipc] ${name} failed:`, message);
      return { ok: false, error: message };
    }
  };
}

module.exports = {
  wrapHandler
};