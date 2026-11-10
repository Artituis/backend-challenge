import { FailureCode, invariant } from './errors';
import { Money } from './money';
import { counter, date, dateAfter, identifier } from './validation';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface MovementContext {
  readonly ledgerEntryId: string;
  readonly transactionId: string;
  readonly at: Date;
}
export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
  readonly opening?: { readonly ledgerEntryId: string; readonly transactionId: string };
}

export class Wallet {
  readonly #identity: Readonly<Pick<WalletState, 'id' | 'playerId' | 'currency' | 'createdAt'>>;
  #balance: Money;
  #version: number;
  #updatedAt: Date;
  readonly #entries: WalletLedgerEntry[] = [];

  private constructor(state: WalletState) {
    identifier(state.id, 'id');
    identifier(state.playerId, 'playerId');
    counter(state.version, 1);
    invariant(!state.balance.isNegative(), FailureCode.InsufficientFunds, 'Balance cannot be negative');
    invariant(state.currency === state.balance.currency, FailureCode.CurrencyMismatch, 'Wallet currency differs');
    this.#identity = Object.freeze({ id: state.id, playerId: state.playerId, currency: state.currency, createdAt: date(state.createdAt) });
    this.#balance = state.balance;
    this.#version = state.version;
    this.#updatedAt = dateAfter(state.updatedAt, state.createdAt);
    Object.freeze(this);
  }
  static open(props: OpenWalletProps): Wallet {
    const wallet = new Wallet({ id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: props.initialBalance, version: 1, createdAt: props.at, updatedAt: props.at });
    if (props.initialBalance.isPositive()) {
      invariant(props.opening !== undefined, FailureCode.InvalidPayload, 'Positive opening requires transaction and ledger IDs');
      wallet.#entries.push(WalletLedgerEntry.create({ id: props.opening.ledgerEntryId, walletId: props.id,
        transactionId: props.opening.transactionId, direction: LedgerDirection.Credit, money: props.initialBalance,
        balanceBefore: Money.zero(wallet.currency), balanceAfter: props.initialBalance, createdAt: props.at }));
    }
    return wallet;
  }
  static rehydrate(state: WalletState): Wallet { return new Wallet(state); }
  get id(): string { return this.#identity.id; }
  get playerId(): string { return this.#identity.playerId; }
  get currency(): string { return this.#identity.currency; }
  get createdAt(): Date { return date(this.#identity.createdAt); }
  get balance(): Money { return this.#balance; }
  get version(): number { return this.#version; }
  get updatedAt(): Date { return date(this.#updatedAt); }
  /** Entries produced during this aggregate's unit of work, excluding persisted history. */
  get ledgerEntries(): readonly WalletLedgerEntry[] { return Object.freeze([...this.#entries]); }
  debit(money: Money, context: MovementContext, reversal = false): WalletLedgerEntry | undefined {
    return this.apply(money, LedgerDirection.Debit, context, reversal);
  }
  credit(money: Money, context: MovementContext): WalletLedgerEntry | undefined {
    return this.apply(money, LedgerDirection.Credit, context, false);
  }
  private apply(money: Money, direction: LedgerDirection, context: MovementContext, reversal: boolean): WalletLedgerEntry | undefined {
    invariant(money.currency === this.currency, FailureCode.CurrencyMismatch, 'Wallet currency differs');
    invariant(!money.isNegative(), FailureCode.InvalidMoney, 'Movement amount cannot be negative');
    identifier(context.transactionId, 'transactionId');
    identifier(context.ledgerEntryId, 'ledgerEntryId');
    const at = dateAfter(context.at, this.#updatedAt);
    if (money.isZero()) return undefined;
    invariant(!this.#entries.some(entry => entry.transactionId === context.transactionId || entry.id === context.ledgerEntryId),
      FailureCode.IdempotencyConflict, 'Movement already applied in this unit of work');
    const balanceAfter = direction === LedgerDirection.Debit ? this.#balance.subtract(money) : this.#balance.add(money);
    invariant(!balanceAfter.isNegative(), reversal ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds,
      'Movement would produce a negative balance');
    counter(this.#version + 1, 1);
    const entry = WalletLedgerEntry.create({ id: context.ledgerEntryId, walletId: this.id,
      transactionId: context.transactionId, direction, money, balanceBefore: this.#balance, balanceAfter, createdAt: at });
    this.#entries.push(entry);
    this.#balance = balanceAfter;
    this.#version += 1;
    this.#updatedAt = at;
    return entry;
  }
}
