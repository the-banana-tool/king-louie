// tests/helpers/close-history-stores.js
// On Windows an open SQLite file keeps its folder from being deleted, so a
// test that builds a core (which opens <dataDir>/history.sqlite for its whole
// life) closes every store it opened before removing the data dir. Requiring
// this module records each HistoryStore.open in this test process.
const { HistoryStore } = require('../../src/history');

const opened = new Set();
if (!HistoryStore.__klTracked) {
  const open = HistoryStore.open;
  HistoryStore.open = function trackedOpen(...args) {
    const store = open.apply(this, args);
    opened.add(store);
    return store;
  };
  HistoryStore.__klTracked = true;
}

function closeOpenHistoryStores() {
  for (const store of opened) {
    try { store.close(); } catch { /* already closed */ }
  }
  opened.clear();
}

module.exports = { closeOpenHistoryStores };
