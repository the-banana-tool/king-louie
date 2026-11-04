// src/ipc/single-instance.js
// One desktop per profile (attach stage 2 §6.5): two desktops writing one
// userData is what the backup's check cannot catch from inside. Chromium's lock
// is keyed on the userData path in force when it is asked for, so this runs
// after --user-data-dir is applied, and launches on other profiles (the e2e
// suite's) stay independent. app.relaunch waits for its parent to exit, so a
// relaunch does not lose to its parent's lock.
//
// The second instance's argv, working directory and data come with the event
// and are never read: whoever can start the binary must not be able to steer
// the running desktop by its arguments.
function claimSingleInstance({ app, getWindow }) {
  if (!app.requestSingleInstanceLock()) return false;
  app.on('second-instance', () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  return true;
}

module.exports = { claimSingleInstance };
