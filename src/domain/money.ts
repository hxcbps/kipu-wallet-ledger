import { AppError } from '../lib/errors.js';

const MONEY_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;

export function parseAmountToMinor(value: string, allowZero = false): bigint {
  const match = MONEY_PATTERN.exec(value);
  if (match === null) {
    throw new AppError(
      422,
      'INVALID_AMOUNT',
      'amount must be a non-negative decimal string with at most two fractional digits',
    );
  }

  const [whole = '0', fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if ((!allowZero && minor === 0n) || minor > MAX_MINOR_UNITS) {
    throw new AppError(
      422,
      'INVALID_AMOUNT',
      allowZero
        ? 'amount is outside the supported range'
        : 'amount must be greater than zero and within the supported range',
    );
  }
  return minor;
}

export function formatMinorAmount(value: bigint | string): string {
  const minor = typeof value === 'bigint' ? value : BigInt(value);
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
