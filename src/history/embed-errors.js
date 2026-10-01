// src/history/embed-errors.js
// Errors from embedding and reranking (recall spec §5.2, §15). Callers branch
// on the code:
//   EMBED_WORKER_CRASHED  the worker exited with a request in flight
//   EMBED_WORKER_TIMEOUT  a request ran past its timeout; the worker was killed
//   EMBED_DISABLED        the worker crashed too often; off for this session
//   EMBED_STOPPED         the runner was stopped (shutdown)
//   MODEL_UNAVAILABLE     a model did not load (download, runtime, files)
//   MODEL_NOT_LOADED, MODEL_CHANGED  a request for a model the worker does not hold
//   RERANK_TIMEOUT        rerank slices ran past their deadline
//   RERANK_UNAVAILABLE    no reranker yet: the EmbedderHost has not started
//                         (KL_TEST_MODE, e2e, before the background checks);
//                         the Retriever keeps the fused order without a warning
//   EMBEDDER_UNAVAILABLE  a hosted embedder cannot be built (no embed call)
//   EMBED_FAILED          anything else (a malformed reply, a bad vector)
class EmbedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmbedError';
    this.code = code;
  }
}

// Failures of the worker process, not of the embedder: the runner restarts
// the worker, and the indexer isolates the chunk that caused it.
const WORKER_FAILURES = new Set(['EMBED_WORKER_CRASHED', 'EMBED_WORKER_TIMEOUT']);

// Not failures at all: a switch racing a call, or the runner stopped at
// shutdown. No state change, no warning, no toast.
const NOT_FAILURES = new Set(['MODEL_CHANGED', 'EMBED_STOPPED']);

module.exports = { EmbedError, WORKER_FAILURES, NOT_FAILURES };
