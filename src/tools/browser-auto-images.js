'use strict';

// The images a browser tool attaches by itself (browser runner spec §8.2,
// §8.3, C-10): after a failed acting action or an unknown page state. At most
// AUTO_IMAGES_PER_RUN per run; ToolExecutor builds one budget per executor
// (one run) and hands it to every call as `browserAutoImages`. An on-demand
// screenshot never takes from it.

const AUTO_IMAGES_PER_RUN = 3;

function createAutoImageBudget(limit = AUTO_IMAGES_PER_RUN) {
  let left = limit;
  return Object.freeze({
    // true (and one fewer left) while the budget lasts; false after.
    take() {
      if (left <= 0) return false;
      left -= 1;
      return true;
    },
    get remaining() { return left; },
  });
}

module.exports = { AUTO_IMAGES_PER_RUN, createAutoImageBudget };
