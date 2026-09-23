const TIMED_OUT = Symbol('timed-out');

/**
 * Race `promise` against a deadline. Never rejects on timeout: after `ms` it
 * resolves with TIMED_OUT and calls `onTimeout(label, ms)`. A rejection of
 * `promise` itself is passed through unchanged. The timer is unref'd so it
 * never keeps the process alive, and cleared as soon as `promise` settles.
 */
function withTimeout(promise, ms, label, onTimeout = () => {}) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      onTimeout(label, ms);
      resolve(TIMED_OUT);
    }, ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  const settled = Promise.resolve(promise).finally(() => clearTimeout(timer));
  return Promise.race([settled, deadline]);
}

module.exports = { withTimeout, TIMED_OUT };
