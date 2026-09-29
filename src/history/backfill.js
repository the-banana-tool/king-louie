// src/history/backfill.js
// Chunks the messages a store held before schema step 2, after startup and
// a batch per tick (setImmediate by default), so a big profile's first H2
// start is not blocked by it. Search simply misses the messages not indexed
// yet. Closing the store, or stop(), ends it; the cursor in the store's meta
// resumes it on the next start. A read-only or in-memory store never
// backfills.
const { createLogger } = require('../logging');

const DEFAULT_BATCH = 500;
const DEFAULT_LOG_EVERY = 20;

function startChunkBackfill(store, { batchSize = DEFAULT_BATCH, logEvery = DEFAULT_LOG_EVERY, schedule = setImmediate, log = createLogger('history') } = {}) {
  let stopped = false;
  let indexed = 0;
  let batches = 0;
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const finish = (finished) => resolve({ indexed, finished });

  const eligible = store && typeof store.backfillChunks === 'function' && store.isOpen
    && !store.readonly && store.dbPath && store.dbPath !== ':memory:';
  const total = eligible ? store.backfillRemaining() : 0;
  if (!eligible || total === 0) {
    finish(eligible);
    return { stop() {}, done };
  }
  log.info(`Indexing ${total} stored messages for recall in the background`);

  const tick = () => {
    if (stopped || !store.isOpen) return finish(false);
    let step;
    try {
      step = store.backfillChunks({ batchSize });
    } catch (err) {
      if (!store.isOpen) return finish(false);
      log.warn(`Indexing stored messages for recall stopped: ${err.message}. It resumes on the next start.`);
      return finish(false);
    }
    indexed += step.indexed;
    batches += 1;
    if (step.done) {
      log.info(`Indexed all ${indexed} stored messages for recall`);
      return finish(true);
    }
    if (batches % logEvery === 0) log.info(`Indexed ${indexed} of ${total} stored messages for recall`);
    return schedule(tick);
  };
  schedule(tick);
  return {
    stop() { stopped = true; },
    done
  };
}

module.exports = { startChunkBackfill };
