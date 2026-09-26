// src/cases/ingest/errors.js
// Every refusal in document ingest carries a stable code and a sentence the
// owner can act on (cases stage 7 spec §9).
class IngestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
  }
}

module.exports = { IngestError };
