import { FailureCode, invariant } from './errors';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/** Exact integer cents. No floating point conversion, rounding or precision limit. */
export class Money {
  readonly #cents: bigint;
  private constructor(
    cents: bigint,
    public readonly currency: string,
  ) {
    this.#cents = cents;
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    invariant(
      typeof amount === 'string' &&
        amount.trim() === amount &&
        /^-?\d+(?:\.\d{1,2})?$/.test(amount),
      FailureCode.InvalidMoney,
      'Amount must be a decimal string with at most two fractional digits',
    );
    invariant(
      typeof currency === 'string' && currency.trim() === currency && /^[A-Z]{3}$/.test(currency),
      FailureCode.InvalidMoney,
      'Currency must be a three-letter uppercase code',
    );
    const negative = amount.startsWith('-');
    const [whole = '', fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return new Money(negative ? -cents : cents, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }
  get amount(): string {
    return this.toString();
  }
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#cents + other.#cents, this.currency);
  }
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#cents - other.#cents, this.currency);
  }
  negate(): Money {
    return new Money(-this.#cents, this.currency);
  }
  isZero(): boolean {
    return this.#cents === 0n;
  }
  isPositive(): boolean {
    return this.#cents > 0n;
  }
  isNegative(): boolean {
    return this.#cents < 0n;
  }
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#cents < other.#cents;
  }
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#cents === other.#cents;
  }
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }
  toString(): string {
    const absolute = this.#cents < 0n ? -this.#cents : this.#cents;
    return `${this.isNegative() ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
  }
  private assertSameCurrency(other: Money): void {
    invariant(
      this.currency === other.currency,
      FailureCode.CurrencyMismatch,
      'Money currencies differ',
    );
  }
}
