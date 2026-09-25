// tests/helpers/hold-event-loop.js
//
// Production pollers and waits (the file courier, the relay's approval cache
// and mailbox) unref their timers so they never keep the service alive. A
// test that awaits one of them therefore has no ref'd handle pending, and on
// Node 22 the test runner sees the event loop empty and cancels the test
// ("Promise resolution is still pending but the event loop has already
// resolved"). holdEventLoop() keeps one ref'd interval open until the
// returned release function runs; call it at the top of the file and pass
// the release to `after`.
function holdEventLoop() {
  const handle = setInterval(() => {}, 60 * 1000);
  return () => clearInterval(handle);
}

module.exports = { holdEventLoop };
