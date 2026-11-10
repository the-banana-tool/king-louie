'use strict';

// Duration fields in s, min or h, never ms (settings redesign Task 12, spec 5.8 rule 3).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { msToUnit, unitToMs } = require('../renderer-helpers/units');

describe('msToUnit', () => {
  it('picks the largest unit that divides exactly', () => {
    assert.deepEqual(msToUnit(60000), { value: 1, unit: 'min' });
    assert.deepEqual(msToUnit(7200000), { value: 2, unit: 'h' });
    assert.deepEqual(msToUnit(30000), { value: 30, unit: 's' });
    assert.deepEqual(msToUnit(90000), { value: 90, unit: 's' });
    assert.deepEqual(msToUnit(5400000), { value: 90, unit: 'min' });
  });

  it('falls back to seconds when no unit divides', () => {
    assert.deepEqual(msToUnit(1500), { value: 1.5, unit: 's' });
  });

  it('shows zero as 0 s', () => {
    assert.deepEqual(msToUnit(0), { value: 0, unit: 's' });
  });

  it('refuses a value that is not a finite number', () => {
    assert.throws(() => msToUnit(NaN), TypeError);
    assert.throws(() => msToUnit('60000'), TypeError);
  });
});

describe('unitToMs', () => {
  it('converts each unit', () => {
    assert.equal(unitToMs(30, 's'), 30000);
    assert.equal(unitToMs(2, 'min'), 120000);
    assert.equal(unitToMs(1, 'h'), 3600000);
  });

  it('gives whole milliseconds for fractional input', () => {
    assert.equal(unitToMs(0.3, 's'), 300);
    assert.equal(unitToMs(1.5, 's'), 1500);
  });

  it('round-trips msToUnit', () => {
    for (const ms of [0, 1500, 30000, 60000, 90000, 3600000, 7200000]) {
      const { value, unit } = msToUnit(ms);
      assert.equal(unitToMs(value, unit), ms);
    }
  });

  it('refuses an unknown unit or a value that is not a finite number', () => {
    assert.throws(() => unitToMs(1, 'ms'), TypeError);
    assert.throws(() => unitToMs(Infinity, 's'), TypeError);
  });
});
