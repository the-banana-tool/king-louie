// Duration fields in s, min or h, never milliseconds (settings redesign Task 12, spec 5.8
// rule 3). The stored value keeps its unit (ms); these convert for the field only.
// A plain script of the renderer's, and a module for its test.
const DURATION_UNIT_MS = Object.freeze({ h: 3600000, min: 60000, s: 1000 });

// The largest unit that divides ms exactly, else seconds (1500 -> 1.5 s).
function msToUnit(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new TypeError('msToUnit needs a finite number');
  if (ms !== 0) {
    for (const unit of ['h', 'min']) {
      if (ms % DURATION_UNIT_MS[unit] === 0) return { value: ms / DURATION_UNIT_MS[unit], unit };
    }
  }
  return { value: ms / DURATION_UNIT_MS.s, unit: 's' };
}

// Whole milliseconds (0.3 s -> 300, not 300.00000000000006).
function unitToMs(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('unitToMs needs a finite number');
  if (!Object.prototype.hasOwnProperty.call(DURATION_UNIT_MS, unit)) throw new TypeError(`Unknown unit: ${unit}`);
  return Math.round(value * DURATION_UNIT_MS[unit]);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DURATION_UNIT_MS, msToUnit, unitToMs };
}
