// The node → front door reconnect schedule (fleet stage 4 §3.9).
const FRONT_DOOR_BACKOFF = Object.freeze({
  baseMs: 1000,
  capMs: 60000,
  resetAfterMs: 5 * 60 * 1000,
  alreadyConnectedMinMs: 5000,
  keyMismatchMinMs: 60000,
  mismatchLogEveryMs: 60 * 60 * 1000
});

// min(60 s, 1 s × 2^n) × uniform(0.5, 1.0), never below minMs.
function frontDoorDelay(attempt, { random = Math.random, minMs = 0 } = {}) {
  const n = Math.max(0, Math.min(Number.isInteger(attempt) ? attempt : 0, 16));
  const base = Math.min(FRONT_DOOR_BACKOFF.capMs, FRONT_DOOR_BACKOFF.baseMs * 2 ** n);
  return Math.max(minMs, Math.round(base * (0.5 + 0.5 * random())));
}

module.exports = { FRONT_DOOR_BACKOFF, frontDoorDelay };
