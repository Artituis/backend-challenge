import { FailureCode, invariant } from './errors';
import type { Money } from './money';
import { date, identifier } from './validation';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export class WalletLedgerEntry {
  readonly #state: LedgerEntryState;
  private constructor(state: LedgerEntryState) {
    this.#state = Object.freeze({ ...state, createdAt: date(state.createdAt) });
    Object.freeze(this);
  }
  static create(props: LedgerEntryState): WalletLedgerEntry {
    for (const field of ['id', 'walletId', 'transactionId'] as const) identifier(props[field], field);
    invariant(Object.values(LedgerDirection).includes(props.direction), FailureCode.InvalidLedger, 'Invalid direction');
    invariant(props.money.isPositive() && !props.balanceBefore.isNegative() && !props.balanceAfter.isNegative(),
      FailureCode.InvalidLedger, 'Ledger requires a positive movement and nonnegative balances');
    const entry = new WalletLedgerEntry(props);
    invariant(entry.isBalanced(), FailureCode.InvalidLedger, 'Ledger arithmetic does not balance');
    return entry;
  }
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry { return WalletLedgerEntry.create(state); }
  get id(): string { return this.#state.id; }
  get walletId(): string { return this.#state.walletId; }
  get transactionId(): string { return this.#state.transactionId; }
  get direction(): LedgerDirection { return this.#state.direction; }
  get money(): Money { return this.#state.money; }
  get balanceBefore(): Money { return this.#state.balanceBefore; }
  get balanceAfter(): Money { return this.#state.balanceAfter; }
  get createdAt(): Date { return date(this.#state.createdAt); }
  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money) : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
