'use strict';

// The take policy holder (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md
// §7.2): one per delegate session, handed to its ToolExecutor as `takePolicy`. While `current`
// holds a policy (src/gui/take-policy.js), its decisions replace the approval prompt; the Take
// tool sets it when a take goes live and clears it when the take ends.

function createTakeHolder() {
  const holder = {
    current: null,
    set(policy) {
      holder.current = policy || null;
    },
    clear() {
      holder.current = null;
    },
  };
  return holder;
}

module.exports = { createTakeHolder };
