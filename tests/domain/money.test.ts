import { describe, expect, test } from 'bun:test';

import { DomainError, FailureCode, Money } from '../../src/domain';
import { money } from './fixtures';

describe('Money', () => {
  test.each([
    ['0', '0.00'],
    ['1', '1.00'],
    ['1.2', '1.20'],
    ['001.20', '1.20'],
    ['-0.00', '0.00'],
    ['-1.2', '-1.20'],
    ['999.99', '999.99'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(money(input).amount).toBe(expected);
    expect(money(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
    expect(Money.from(money(input).toJSON()).equals(money(input))).toBe(true);
  });
  test.each([
    '',
    ' ',
    ' 1.00',
    '1.00 ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e2',
    '1E-2',
    '1.001',
    '1.005',
    '1.999',
    '1.000',
    '-0.001',
    '.01',
    '1.',
    '+1',
    '1,20',
    '0x10',
    '--1',
    '1\n',
  ])('rejects %j instead of rounding or coercing', (value) => {
    expect(() => money(value)).toThrow(DomainError);
  });
  test.each([1, 0, NaN, Infinity, null, undefined, 1n, {}, true])(
    'rejects non-string input %#',
    (value) => {
      expect(() => money(value as string)).toThrow(DomainError);
    },
  );
  test.each(['', 'brl', ' BRL', 'BRL ', 'BRL\n', 'US', 'USDD', '123'])(
    'rejects currency %j',
    (currency) => {
      expect(() => money('1', currency)).toThrow(DomainError);
    },
  );
  test('does exact arithmetic beyond Number.MAX_SAFE_INTEGER', () => {
    expect(money('90071992547409931234567890.99').add(money('0.01')).amount).toBe(
      '90071992547409931234567891.00',
    );
    expect(money('0.10').add(money('0.20')).amount).toBe('0.30');
    expect(money('10.00').subtract(money('0.01')).amount).toBe('9.99');
    expect(money('0.01').subtract(money('1.00')).amount).toBe('-0.99');
    expect(money('-2').add(money('1')).amount).toBe('-1.00');
  });
  test('sign, comparison and equality respect normalized values', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(money('-0').isNegative()).toBe(false);
    expect(money('1').isPositive()).toBe(true);
    expect(money('-1').isNegative()).toBe(true);
    expect(money('-1').isLessThan(money('0'))).toBe(true);
    expect(money('1').isLessThan(money('1'))).toBe(false);
    expect(money('1').equals(money('01.00'))).toBe(true);
    expect(money('1').equals(money('2'))).toBe(false);
    expect(money('1').negate().amount).toBe('-1.00');
    expect(money('0').negate().amount).toBe('0.00');
  });
  test.each(['add', 'subtract', 'equals', 'isLessThan'] as const)(
    '%s rejects mixed currencies',
    (operation) => {
      expect(() => money('1')[operation](money('1', 'USD'))).toThrow(
        expect.objectContaining({ code: FailureCode.CurrencyMismatch }),
      );
    },
  );
  test('is immutable and serializes without leaking bigint', () => {
    const original = money('25');
    const added = original.add(money('1'));
    expect(added).not.toBe(original);
    expect(original.amount).toBe('25.00');
    expect(Object.isFrozen(original)).toBe(true);
    expect(Reflect.set(original, 'currency', 'USD')).toBe(false);
    expect(JSON.stringify(original)).toBe('{"amount":"25.00","currency":"BRL"}');
  });
  test('add/subtract and double negation are exact inverses for a range of signs and magnitudes', () => {
    const samples = [
      '-999999999999999999.99',
      '-1.01',
      '0',
      '0.01',
      '1.99',
      '999999999999999999.99',
    ];
    for (const a of samples)
      for (const b of samples) {
        expect(money(a).add(money(b)).subtract(money(b)).equals(money(a))).toBe(true);
        expect(money(a).negate().negate().equals(money(a))).toBe(true);
      }
  });
});
