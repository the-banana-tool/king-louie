'use strict';
// A problem with how LongHaul was invoked or with its inputs. The CLI prints
// the message alone and exits 2; anything else is a failure (exit 1).
class UsageError extends Error {
  constructor(message, code = 'USAGE') {
    super(message);
    this.name = 'UsageError';
    this.code = code;
  }
}

module.exports = { UsageError };
