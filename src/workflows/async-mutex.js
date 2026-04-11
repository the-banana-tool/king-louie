/**
 * AsyncMutex — a per-key promise-chain mutex.
 *
 * JavaScript is single-threaded but `await` boundaries create interleaving
 * windows: between two awaits in `_save()` (writeFile then rename) another
 * caller's writeFile can land, racing the rename. Likewise pause()/cancel()
 * can mutate workflow state while _executeLoop is mid-await.
 *
 * This is NOT cross-process — Electron's main process is single-process, so
 * a file lock would be overkill. If we ever fork workers, swap this for
 * proper-lockfile keyed by workflow path.
 */

class AsyncMutex {
  constructor() {
    this._chains = new Map();
  }

  /**
   * Run `fn` exclusively for `key`. Calls with the same key are serialized
   * in arrival order. Different keys run in parallel. A rejected `fn` does
   * not poison the chain — subsequent waiters still proceed.
   */
  async run(key, fn) {
    const previous = this._chains.get(key) || Promise.resolve();
    const next = previous.then(() => fn());
    const tail = next.catch(() => {});
    this._chains.set(key, tail);
    try {
      return await next;
    } finally {
      if (this._chains.get(key) === tail) {
        this._chains.delete(key);
      }
    }
  }
}

module.exports = AsyncMutex;
