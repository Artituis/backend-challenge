import { LockMode, QueryOrder, raw } from '@mikro-orm/core';
import type { FilterQuery } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionStatus } from '../../domain';
import type { InboxMessage, OutboxMessage, WagerTransaction, Wallet, WalletLedgerEntry } from '../../domain';
import type { InboxRepository, OutboxRepository, WagerTransactionRepository, WalletLedgerRepository, WalletRepository } from '../../application/ports/persistence';
import { InboxRow, OutboxRow, WagerTransactionRow, WalletLedgerRow, WalletRow } from './entities';
import { inboxMapper, ledgerMapper, outboxMapper, transactionMapper, walletMapper } from './mappers';

export class TransactionScope {
  private active = true;
  constructor(readonly em: EntityManager) {}
  assertActive(): void {
    if (!this.active || !this.em.isInTransaction()) throw new Error('Repository requires an active UnitOfWork callback');
  }
  close(): void { this.active = false; }
}
function batchSize(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Batch size must be between 1 and 1000');
}

/** Tracks the exact domain instance loaded under lock; detached snapshots cannot be saved. */
abstract class TrackedRepository<Row extends object, Aggregate extends object> {
  private readonly rows = new WeakMap<Aggregate, Row>();
  private readonly aggregates = new WeakMap<Row, Aggregate>();
  constructor(protected readonly scope: TransactionScope, private readonly entity: new () => Row,
    private readonly mapper: { toRow(value: Aggregate): Row; toDomain(row: Row): Aggregate }) {}
  protected restore(row: Row): Aggregate {
    const existing = this.aggregates.get(row);
    if (existing) return existing;
    const aggregate = this.mapper.toDomain(row);
    this.rows.set(aggregate, row);
    this.aggregates.set(row, aggregate);
    return aggregate;
  }
  protected async findLocked(where: FilterQuery<Row>): Promise<Aggregate | undefined> {
    this.scope.assertActive();
    const row = await this.scope.em.findOne(this.entity, where, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return row === null ? undefined : this.restore(row);
  }
  add(aggregate: Aggregate): void {
    this.scope.assertActive();
    if (this.rows.has(aggregate)) throw new Error('Aggregate already belongs to this UnitOfWork');
    // A fresh instance must INSERT even if the identity map contains this PK.
    // em.create() would merge an existing managed row and could hide a duplicate.
    const row = Object.assign(new this.entity(), this.mapper.toRow(aggregate));
    this.scope.em.persist(row);
    this.rows.set(aggregate, row);
    this.aggregates.set(row, aggregate);
  }
  save(aggregate: Aggregate): void {
    this.scope.assertActive();
    const row = this.rows.get(aggregate);
    if (!row) throw new Error('Load the aggregate under lock in this UnitOfWork before saving');
    Object.assign(row, this.mapper.toRow(aggregate));
  }
}
export class MikroWalletRepository extends TrackedRepository<WalletRow, Wallet> implements WalletRepository {
  private readonly appended = new WeakSet<WalletLedgerEntry>();
  constructor(scope: TransactionScope) { super(scope, WalletRow, walletMapper); }
  findById(id: string): Promise<Wallet | undefined> { return this.findLocked({ id }); }
  findByPlayer(playerId: string, currency: string): Promise<Wallet | undefined> { return this.findLocked({ playerId, currency }); }
  override add(wallet: Wallet): void { super.add(wallet); this.appendLedger(wallet); }
  override save(wallet: Wallet): void { super.save(wallet); this.appendLedger(wallet); }
  private appendLedger(wallet: Wallet): void {
    const entries = wallet.ledgerEntries;
    entries.forEach((entry, index) => {
      if (this.appended.has(entry)) return;
      const version = wallet.version - entries.length + index + 1;
      this.scope.em.persist(Object.assign(new WalletLedgerRow(), ledgerMapper.toRow(entry, version)));
      this.appended.add(entry);
    });
  }
}
export class MikroWagerTransactionRepository extends TrackedRepository<WagerTransactionRow, WagerTransaction> implements WagerTransactionRepository {
  constructor(scope: TransactionScope) { super(scope, WagerTransactionRow, transactionMapper); }
  findById(id: string): Promise<WagerTransaction | undefined> { return this.findLocked({ id }); }
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findLocked({ providerId, idempotencyKey });
  }
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findLocked({ providerId, externalTransactionId });
  }
  async findPendingReferences(providerId: string, externalId: string, limit: number): Promise<WagerTransaction[]> {
    this.scope.assertActive(); batchSize(limit);
    const rows = await this.scope.em.find(WagerTransactionRow, {
      providerId, referenceExternalTransactionId: externalId, status: WagerTransactionStatus.PendingReference,
    }, { limit, orderBy: { createdAt: QueryOrder.ASC, id: QueryOrder.ASC }, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE });
    return rows.map(row => this.restore(row));
  }
}
export class MikroWalletLedgerRepository implements WalletLedgerRepository {
  constructor(private readonly scope: TransactionScope) {}
  async findByTransaction(walletId: string, transactionId: string): Promise<WalletLedgerEntry | undefined> {
    this.scope.assertActive();
    const row = await this.scope.em.findOne(WalletLedgerRow, { walletId, transactionId });
    return row === null ? undefined : ledgerMapper.toDomain(row);
  }
  async listByWallet(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    this.scope.assertActive(); batchSize(limit);
    if (!Number.isSafeInteger(afterVersion) || afterVersion < 0) throw new RangeError('Invalid ledger cursor');
    const rows = await this.scope.em.find(WalletLedgerRow, { walletId, walletVersion: { $gt: afterVersion } },
      { limit, orderBy: { walletVersion: QueryOrder.ASC } });
    return rows.map(ledgerMapper.toDomain);
  }
}
export class MikroInboxRepository extends TrackedRepository<InboxRow, InboxMessage> implements InboxRepository {
  constructor(scope: TransactionScope) { super(scope, InboxRow, inboxMapper); }
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    return this.findLocked({ consumerName, messageId });
  }
  async findPending(consumerName: string, limit: number): Promise<InboxMessage[]> {
    this.scope.assertActive(); batchSize(limit);
    const rows = await this.scope.em.find(InboxRow, { consumerName, processedAt: null },
      { limit, orderBy: { receivedAt: QueryOrder.ASC, messageId: QueryOrder.ASC }, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE });
    return rows.map(row => this.restore(row));
  }
}
export class MikroOutboxRepository extends TrackedRepository<OutboxRow, OutboxMessage> implements OutboxRepository {
  constructor(scope: TransactionScope) { super(scope, OutboxRow, outboxMapper); }
  findById(id: string): Promise<OutboxMessage | undefined> { return this.findLocked({ id }); }
  async findDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    this.scope.assertActive(); batchSize(limit);
    const due = raw('coalesce(next_attempt_at, occurred_at)');
    const rows = await this.scope.em.find(OutboxRow, { publishedAt: null, [due]: { $lte: now } },
      { limit, orderBy: { [due]: QueryOrder.ASC, id: QueryOrder.ASC }, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE });
    return rows.map(row => this.restore(row));
  }
}
