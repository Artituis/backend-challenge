import type { InboxMessage, OutboxMessage, WagerTransaction, Wallet, WalletLedgerEntry } from '../../domain';
import type { WagerTransactionKind } from '../../domain';
import type { WagerResult } from '../wagering/contracts';

/** Repositories live only inside the UnitOfWork callback. Mutable aggregate reads acquire row locks. */
export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findByPlayer(playerId: string, currency: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  /** Also appends all new ledger entries emitted by this aggregate. */
  save(wallet: Wallet): void;
}
export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  /** Read-only snapshot: reference validation must not lock another wallet's transactions. */
  findReference(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  /** Caller must hold the target wallet lock. */
  hasProcessedReversal(referenceId: string, kind: WagerTransactionKind): Promise<boolean>;
  findPendingReferences(providerId: string, externalId: string, limit: number): Promise<WagerTransaction[]>;
  add(transaction: WagerTransaction): void;
  save(transaction: WagerTransaction): void;
}
export interface WalletLedgerRepository {
  findByTransaction(walletId: string, transactionId: string): Promise<WalletLedgerEntry | undefined>;
  listByWallet(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
}
export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  findPending(consumerName: string, limit: number): Promise<InboxMessage[]>;
  add(message: InboxMessage): void;
  save(message: InboxMessage): void;
}
export interface OutboxRepository {
  findById(id: string): Promise<OutboxMessage | undefined>;
  /** FOR UPDATE SKIP LOCKED; the claim lasts until this SQL transaction ends. */
  findDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  add(message: OutboxMessage): void;
  save(message: OutboxMessage): void;
}
export interface Repositories {
  /** Acquire once, before row reads. Protects identities even when rows do not yet exist. */
  readonly identities: { lock(keys: readonly string[]): Promise<void> };
  readonly results: {
    find(transactionId: string): Promise<WagerResult | undefined>;
    add(result: WagerResult): void;
  };
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: WalletLedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
