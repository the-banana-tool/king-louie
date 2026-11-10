// Auto-save for individual settings (settings redesign Task 12, spec 5.8 rule 1 and 7.1).
// A plain script of the renderer's, and a module for its test: the renderer has no require.
//
// Text fields call change(v) (debounced by delayMs); switches and selects call
// change(v, { immediate: true }). Only the last value of a burst is saved. Saves never
// overlap: a change made while one is in flight waits for it, and then only the newest
// waiting value is sent. Only the save of the newest value reports 'saved' or 'error': an
// older save that ends after a newer change reports nothing, so it can neither say
// "Saved" for a value that is not the one in the field nor put the field back over newer
// typing. On 'error' the caller puts the field back to the stored value; info.saved is
// the last value this saver saved (undefined when it has saved none).
//
// Forms that create or edit a whole object (the profile editor, a new scheduled job, a
// webhook, an MCP server, a vault entry, a custom role, a local server, any key or token)
// keep their explicit button and do not use this.
function createAutosave({
  save,
  delayMs = 600,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onState = () => {}
} = {}) {
  let saveFn = save;
  let delay = delayMs;
  let stateFn = onState;
  let pending;
  let hasPending = false;
  let changeSeq = 0;
  let timer = null;
  let current = null; // the in-flight save's settle promise; it never rejects
  let wantRun = false; // run() was asked for while a save was in flight
  let lastSaved;

  function report(state, info) {
    try {
      stateFn(state, info);
    } catch {
      // A painting failure must not stop later saves.
    }
  }

  function run() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!hasPending) return;
    if (current) {
      wantRun = true;
      return;
    }
    const value = pending;
    const seq = changeSeq;
    hasPending = false;
    pending = undefined;
    report('saving', { value });
    let started;
    try {
      started = Promise.resolve(saveFn(value));
    } catch (err) {
      started = Promise.reject(err);
    }
    current = started
      .then(
        (result) => (result && result.ok ? { ok: true } : { ok: false, error: (result && result.error) || 'Could not save.' }),
        (err) => ({ ok: false, error: (err && typeof err.message === 'string' && err.message) || 'Could not save.' })
      )
      .then((result) => {
        current = null;
        if (result.ok) lastSaved = value;
        if (seq === changeSeq) {
          if (result.ok) report('saved', { value, saved: lastSaved });
          else report('error', { error: result.error, value, saved: lastSaved });
        }
        if (wantRun) {
          wantRun = false;
          run();
        }
      });
  }

  function change(value, { immediate = false } = {}) {
    pending = value;
    hasPending = true;
    changeSeq += 1;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (immediate) {
      run();
    } else {
      // A newer half-typed value waits for its own timer, even when an earlier
      // immediate change asked to run as soon as the save in flight ends.
      wantRun = false;
      timer = setTimer(run, delay);
    }
  }

  // Sends a pending value now (synchronously when no save is in flight) and resolves
  // once every save, that one and any value changed meanwhile included, has ended.
  async function flush() {
    run();
    while (current) {
      await current;
      run();
    }
  }

  // Swaps the handlers in place, keeping the pending value and the save in flight, so
  // saves for one setting stay sequential. Results that land after the swap go to the
  // new onState. A key left out keeps its handler.
  function setHandlers({ save: nextSave, onState: nextState, delayMs: nextDelay } = {}) {
    if (typeof nextSave === 'function') saveFn = nextSave;
    if (typeof nextState === 'function') stateFn = nextState;
    if (typeof nextDelay === 'number') delay = nextDelay;
  }

  return { change, flush, setHandlers };
}

// One saver per key. register(key, { save, delayMs?, onState? }) creates the key's
// saver, or swaps the handlers of the one it has (a page re-render), and returns it.
// onAnyState(state, info) runs for every saver before its own onState (the header's
// indicator). flushAll() flushes every saver and never rejects.
function createAutosaveRegistry({ onAnyState, setTimer, clearTimer } = {}) {
  const savers = new Map();
  const wrap = (onState) => (state, info) => {
    if (typeof onAnyState === 'function') onAnyState(state, info);
    if (typeof onState === 'function') onState(state, info);
  };
  function register(key, { save, delayMs, onState } = {}) {
    const existing = savers.get(key);
    if (existing) {
      existing.setHandlers({ save, delayMs, onState: wrap(onState) });
      return existing;
    }
    const saver = createAutosave({
      save,
      ...(delayMs === undefined ? {} : { delayMs }),
      ...(setTimer ? { setTimer } : {}),
      ...(clearTimer ? { clearTimer } : {}),
      onState: wrap(onState)
    });
    savers.set(key, saver);
    return saver;
  }
  function flushAll() {
    return Promise.all([...savers.values()].map((saver) => saver.flush())).then(() => {});
  }
  return { register, flushAll, get: (key) => savers.get(key) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createAutosave, createAutosaveRegistry };
}
