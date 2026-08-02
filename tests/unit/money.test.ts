import { describe, expect, it } from 'vitest';
import { formatMinorAmount, parseAmountToMinor } from '../../src/domain/money.js';
import { AppError } from '../../src/lib/errors.js';

describe('money', () => {
  it.each([
    ['1', 100n],
    ['1.2', 120n],
    ['1.20', 120n],
    ['0.01', 1n],
    ['92233720368547758.07', 9_223_372_036_854_775_807n],
  ])('parses %s without floating-point arithmetic', (input, expected) => {
    expect(parseAmountToMinor(input)).toBe(expected);
  });

  it.each(['0', '0.00', '-1.00', '01.00', '1.001', '1e3', 'NaN', ' 1.00']) (
    'rejects ambiguous or non-positive amount %s',
    (input) => {
      expect(() => parseAmountToMinor(input)).toThrow(AppError);
    },
  );

  it('allows zero only when explicitly requested', () => {
    expect(parseAmountToMinor('0.00', true)).toBe(0n);
  });

  it.each([
    [0n, '0.00'],
    [1n, '0.01'],
    [120n, '1.20'],
    [-125n, '-1.25'],
  ])('formats %s minor units as %s', (input, expected) => {
    expect(formatMinorAmount(input)).toBe(expected);
  });
});
