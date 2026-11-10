import { describe, expect, test } from 'bun:test';
import { DomainError, FailureCode, LedgerDirection, Wallet, WalletLedgerEntry } from '../../src/domain';
import { at, later, money, movement, wallet } from './fixtures';

describe('Wallet', () => {
  test('opens at version one with a balanced opening entry', () => {
    const w = wallet();
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('100.00');
    expect(w.ledgerEntries).toHaveLength(1);
    expect(w.ledgerEntries[0]?.balanceBefore.amount).toBe('0.00');
    expect(w.ledgerEntries[0]?.isBalanced()).toBe(true);
  });
  test('zero opening needs no ledger; positive opening requires explicit audit IDs', () => {
    expect(Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('0'), at: at() }).ledgerEntries).toHaveLength(0);
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('1'), at: at() })).toThrow(DomainError);
    expect(() => wallet({ initialBalance: money('-0.01') })).toThrow(DomainError);
  });
  test('debits and credits produce exact matching ledger entries and increment version once', () => {
    const w = wallet();
    const debit = w.debit(money('80'), movement());
    expect(debit?.direction).toBe(LedgerDirection.Debit);
    expect(debit?.balanceBefore.amount).toBe('100.00');
    expect(debit?.balanceAfter.amount).toBe('20.00');
    expect(w.version).toBe(2);
    expect(w.updatedAt).toEqual(later());
    const credit = w.credit(money('0.01'), movement('win-1'));
    expect(credit?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('20.01');
    expect(w.version).toBe(3);
    const reconstructed = w.ledgerEntries.reduce((balance, entry) => entry.direction === LedgerDirection.Credit
      ? balance.add(entry.money) : balance.subtract(entry.money), money('0'));
    expect(reconstructed.equals(w.balance)).toBe(true);
  });
  test('can debit exactly the full balance', () => {
    const w = wallet();
    w.debit(money('100'), movement());
    expect(w.balance.isZero()).toBe(true);
  });
  test.each(['debit', 'credit'] as const)('zero %s does not change version, timestamp or ledger', method => {
    const w = wallet();
    expect(w[method](money('0'), movement())).toBeUndefined();
    expect(w.version).toBe(1);
    expect(w.updatedAt).toEqual(at());
    expect(w.ledgerEntries).toHaveLength(1);
    expect(() => w[method](money('0', 'USD'), movement())).toThrow(DomainError);
  });
  test('failed debits leave every observable field unchanged, with distinct reversal failure code', () => {
    const w = wallet();
    expect(() => w.debit(money('100.01'), movement())).toThrow(expect.objectContaining({ code: FailureCode.InsufficientFunds }));
    expect(() => w.debit(money('100.01'), movement(), true)).toThrow(expect.objectContaining({ code: FailureCode.ReversalInsufficientFunds }));
    expect(w.balance.amount).toBe('100.00');
    expect(w.version).toBe(1);
    expect(w.updatedAt).toEqual(at());
    expect(w.ledgerEntries).toHaveLength(1);
  });
  test.each(['debit', 'credit'] as const)('%s rejects negative and mismatched amounts atomically', method => {
    const w = wallet();
    expect(() => w[method](money('-1'), movement())).toThrow(DomainError);
    expect(() => w[method](money('1', 'USD'), movement())).toThrow(DomainError);
    expect(w.version).toBe(1);
    expect(w.ledgerEntries).toHaveLength(1);
  });
  test('invalid ledger metadata and timestamps cannot partially apply a movement', () => {
    const w = wallet();
    expect(() => w.credit(money('1'), { ...movement(), ledgerEntryId: '' })).toThrow(DomainError);
    expect(() => w.credit(money('1'), { ...movement(), at: new Date('invalid') })).toThrow(DomainError);
    expect(() => w.credit(money('1'), { ...movement(), at: new Date('2025-01-01') })).toThrow(DomainError);
    expect(w.balance.amount).toBe('100.00');
    expect(w.version).toBe(1);
  });
  test('rejects duplicate movements within the unit of work', () => {
    const w = wallet();
    w.debit(money('80'), movement());
    expect(() => w.debit(money('10'), movement())).toThrow(DomainError);
    expect(w.balance.amount).toBe('20.00');
    expect(w.version).toBe(2);
  });
  test('defensive date and ledger snapshots prevent external mutation', () => {
    const input = at();
    const w = wallet({ at: input });
    input.setFullYear(2000);
    w.createdAt.setFullYear(2001);
    w.updatedAt.setFullYear(2002);
    expect(w.createdAt).toEqual(at());
    expect(w.updatedAt).toEqual(at());
    const entries = w.ledgerEntries;
    expect(Object.isFrozen(entries)).toBe(true);
    w.credit(money('1'), movement());
    expect(entries).toHaveLength(1);
    expect(w.ledgerEntries).toHaveLength(2);
    expect(Reflect.set(w, 'version', 500)).toBe(false);
  });
  test('rehydrates without generating ledger or incrementing version', () => {
    const w = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: money('12.34'),
      version: 42, createdAt: at(), updatedAt: later() });
    expect(w.version).toBe(42);
    expect(w.ledgerEntries).toHaveLength(0);
    w.credit(money('1'), movement());
    expect(w.version).toBe(43);
  });
  test.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid persisted version %s', version => {
    expect(() => Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: money('0'),
      version, createdAt: at(), updatedAt: at() })).toThrow(DomainError);
  });
  test('version overflow is atomic', () => {
    const w = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: money('1'),
      version: Number.MAX_SAFE_INTEGER, createdAt: at(), updatedAt: at() });
    expect(() => w.credit(money('1'), movement())).toThrow(DomainError);
    expect(w.balance.amount).toBe('1.00');
    expect(w.ledgerEntries).toHaveLength(0);
  });
});

describe('WalletLedgerEntry', () => {
  const props = () => ({ id: 'l', walletId: 'w', transactionId: 't', direction: LedgerDirection.Debit,
    money: money('20'), balanceBefore: money('100'), balanceAfter: money('80'), createdAt: at() });
  test('validates debit and credit equations', () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
    expect(WalletLedgerEntry.create({ ...props(), direction: LedgerDirection.Credit, balanceAfter: money('120') }).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...props(), balanceAfter: money('79.99') })).toThrow(DomainError);
    expect(() => WalletLedgerEntry.create({ ...props(), money: money('20', 'USD') })).toThrow(DomainError);
    expect(() => WalletLedgerEntry.create({ ...props(), balanceAfter: money('80', 'USD') })).toThrow(DomainError);
  });
  test.each(['0', '-1'])('rejects %s movement', amount => {
    expect(() => WalletLedgerEntry.create({ ...props(), money: money(amount) })).toThrow(DomainError);
  });
  test('rejects negative balances and unknown direction', () => {
    expect(() => WalletLedgerEntry.create({ ...props(), balanceBefore: money('-1'), balanceAfter: money('-21') })).toThrow(DomainError);
    expect(() => WalletLedgerEntry.create({ ...props(), direction: 'BAD' as LedgerDirection })).toThrow(DomainError);
  });
  test('rehydrates immutably with defensive dates', () => {
    const input = props();
    const entry = WalletLedgerEntry.rehydrate(input);
    input.createdAt.setFullYear(2000);
    entry.createdAt.setFullYear(2000);
    expect(entry.createdAt).toEqual(at());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Reflect.set(entry, 'money', money('200'))).toBe(false);
  });
});
