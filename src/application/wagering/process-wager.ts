import { DomainError, FailureCode, InboxMessage, LedgerDirection, Money, OutboxMessage,
  WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain';
import type { CreateWagerTransactionProps, JsonObject, Wallet, WalletLedgerEntry } from '../../domain';
import type { Repositories, UnitOfWork } from '../ports/persistence';
import { silentObserver } from '../ports/telemetry';
import type { WagerObserver } from '../ports/telemetry';
import { RetryableTransactionError } from './contracts';
import type { ApplicationRuntime, WagerCommand, WagerResponse, WagerResult } from './contracts';

const businessFailures = new Set([
  FailureCode.InsufficientFunds, FailureCode.ReversalInsufficientFunds, FailureCode.InvalidReference,
  FailureCode.CurrencyMismatch, FailureCode.AlreadyReversed,
]);

/** No network calls, publishing or queue ack inside this transaction/retry boundary. */
export class ProcessWager {
  constructor(private readonly uow: UnitOfWork, private readonly runtime: ApplicationRuntime,
    private readonly observer: WagerObserver = silentObserver) {}

  /** Background retry shares the financial rules, but never replaces the submission response. */
  async reprocessNextPending(policy: { ttlMs: number; baseDelayMs: number; maxDelayMs: number }): Promise<boolean> {
    let committed: { result: WagerResponse; walletId: string; providerId: string; correlationId?: string; messageId?: string } | undefined;
    const worked = await this.uow.run(async r => {
      const now = this.runtime.now();
      const job = await r.pendingReferences.claim(now);
      if (!job) return false;
      const tx = await r.transactions.findById(job.transactionId);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) {
        await r.pendingReferences.complete(job.transactionId);
        return true;
      }
      const wallet = await r.wallets.findById(tx.walletId);
      if (!wallet) throw new DomainError(FailureCode.InvalidState, 'Pending wager wallet missing');
      const at = new Date(Math.max(now.getTime(), tx.createdAt.getTime(), wallet.updatedAt.getTime()));
      const expiresAt = tx.createdAt.getTime() + policy.ttlMs;
      let entry: WalletLedgerEntry | undefined;
      if (now.getTime() >= expiresAt) tx.reject(FailureCode.ReferenceExpired);
      else {
        const reference = await r.transactions.findReference(tx.providerId, tx.referenceExternalTransactionId!);
        // References which themselves await another reference can still become valid.
        if (!reference || reference.status === WagerTransactionStatus.PendingReference || reference.status === WagerTransactionStatus.Pending) {
          const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(job.attempts, 30));
          await r.pendingReferences.retry(tx.id, new Date(Math.min(expiresAt, now.getTime() + delay)));
          return true;
        }
        entry = await this.apply(r, wallet, tx, reference, at);
      }
      r.transactions.save(tx);
      if (entry) r.wallets.save(wallet);
      this.enqueue(r, tx, { transactionId: tx.id, status: tx.status, balance: wallet.balance.toJSON(),
        walletVersion: wallet.version, failureCode: tx.failureCode ?? null }, entry, at, job.correlationId ?? tx.id, job.messageId);
      committed = { result: { transactionId: tx.id, status: tx.status, balance: wallet.balance.toJSON(),
        walletVersion: wallet.version, failureCode: tx.failureCode ?? null, idempotentReplay: false },
        walletId: tx.walletId, providerId: tx.providerId, correlationId: job.correlationId ?? tx.id,
        ...(job.messageId ? { messageId: job.messageId } : {}) };
      await r.pendingReferences.complete(tx.id);
      return true;
    });
    if (committed) this.observer.committed(committed.result, committed);
    return worked;
  }

  async execute(command: WagerCommand): Promise<WagerResponse> {
    const correlationId = command.correlationId;
    // Project and normalize once, before awaiting; callers cannot mutate an in-flight request.
    const input: CreateWagerTransactionProps = {
      id: this.runtime.id(), providerId: command.providerId, externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey, payloadHash: 'not-yet-hashed', walletId: command.walletId,
      playerId: command.playerId, roundId: command.roundId, gameId: command.gameId, kind: command.kind,
      money: Money.from(command.money), createdAt: this.runtime.now(),
      ...(command.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: command.referenceExternalTransactionId }),
    };
    const props = { ...input, payloadHash: this.runtime.sha256(WagerTransaction.canonicalPayload(input)) };
    // Runtime validation also prevents OPENING from untyped transport callers.
    WagerTransaction.create(props);
    const delivery = command.delivery === undefined ? undefined : {
      consumerName: command.delivery.consumerName, messageId: command.delivery.messageId,
      // Bind delivery to the key as well as the business payload; never trust a supplied hash.
      payloadHash: this.runtime.sha256(JSON.stringify({ idempotencyKey: props.idempotencyKey, payloadHash: props.payloadHash })),
    };
    if (delivery) InboxMessage.receive({ ...delivery, receivedAt: props.createdAt });
    const keys = [JSON.stringify(['wager-key', props.providerId, props.idempotencyKey]),
      JSON.stringify(['wager-external', props.providerId, props.externalTransactionId])];
    if (delivery) keys.push(JSON.stringify(['inbox', delivery.consumerName, delivery.messageId]));

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.uow.run(async r => {
          await r.identities.lock(keys);
          const inbox = delivery === undefined ? undefined : await r.inbox.find(delivery.consumerName, delivery.messageId);
          if (delivery) inbox?.assertSameDelivery(delivery);
          const byKey = await r.transactions.findByIdempotencyKey(props.providerId, props.idempotencyKey);
          byKey?.assertIdempotentReplay(props);
          const byExternal = await r.transactions.findByExternalId(props.providerId, props.externalTransactionId);
          byExternal?.assertIdempotentReplay(props);
          const existing = byKey ?? byExternal;
          if (existing) {
            const result = await r.results.find(existing.id);
            if (!result) throw new DomainError(FailureCode.InvalidState, 'Existing wager has no persisted submission result');
            this.finishInbox(r, delivery, inbox, props.createdAt);
            return { ...result, idempotentReplay: true };
          }
          if (inbox?.isProcessed()) throw new DomainError(FailureCode.InvalidState, 'Processed inbox has no corresponding wager');

          // Serialize all financial decisions, including insufficient-funds/reversal checks.
          const wallet = await r.wallets.findById(props.walletId);
          if (!wallet || wallet.playerId !== props.playerId) {
            throw new DomainError(FailureCode.InvalidPayload, 'Wallet not found for this player');
          }
          if (wallet.currency !== props.money.currency) throw new DomainError(FailureCode.CurrencyMismatch, 'Wallet currency differs');
          // Clock skew between instances cannot make the ledger timeline go backwards.
          const at = new Date(Math.max(this.runtime.now().getTime(), wallet.updatedAt.getTime(), props.createdAt.getTime()));
          const tx = WagerTransaction.create(props);
          const reference = props.referenceExternalTransactionId === undefined ? undefined
            : await r.transactions.findReference(props.providerId, props.referenceExternalTransactionId);
          const entry = await this.apply(r, wallet, tx, reference, at);
          r.transactions.add(tx);
          if (entry) r.wallets.save(wallet);

          const result: WagerResult = { transactionId: tx.id, status: tx.status, balance: wallet.balance.toJSON(),
            walletVersion: wallet.version, failureCode: tx.failureCode ?? null };
          r.results.add(result);
          this.enqueue(r, tx, result, entry, at, correlationId, delivery?.messageId);
          this.finishInbox(r, delivery, inbox, at);
          return { ...result, idempotentReplay: false };
        }); // Promise resolves only after flush, deferred constraints and COMMIT.
        this.observer.committed(response, { walletId: props.walletId, providerId: props.providerId });
        return response;
      } catch (error) {
        if (!(error instanceof RetryableTransactionError) || attempt >= 3) throw error;
        this.observer.retry();
        await this.runtime.pause(25 * 2 ** attempt + Math.floor(this.runtime.random() * 25));
      }
    }
  }

  private async apply(r: Repositories, wallet: Wallet, tx: WagerTransaction,
    reference: WagerTransaction | undefined, at: Date): Promise<WalletLedgerEntry | undefined> {
    if (tx.referenceExternalTransactionId !== undefined && (reference === undefined
      || reference.status === WagerTransactionStatus.PendingReference || reference.status === WagerTransactionStatus.Pending)) {
      tx.markPendingReference();
      return undefined;
    }
    let direction: LedgerDirection;
    try {
      if (tx.kind === WagerTransactionKind.Loss) {
        tx.markProcessed(reference, at); // Validates even an optional LOSS reference.
        return undefined;
      }
      direction = tx.ledgerDirectionFor(reference);
      if (tx.requiresReference() && reference && await r.transactions.hasProcessedReversal(reference.id, tx.kind)) {
        throw new DomainError(FailureCode.AlreadyReversed, 'Reference already reversed by this operation type');
      }
      const context = { ledgerEntryId: this.runtime.id(), transactionId: tx.id, at };
      // Wallet validates everything before mutation. Only expected business failures are persisted.
      const entry = direction === LedgerDirection.Debit
        ? wallet.debit(tx.money, context, tx.kind === WagerTransactionKind.Rollback)
        : wallet.credit(tx.money, context);
      // Reference and time were already validated; unexpected errors must abort the SQL transaction.
      tx.markProcessed(reference, at);
      return entry;
    } catch (error) {
      if (!(error instanceof DomainError) || !businessFailures.has(error.code) || wallet.ledgerEntries.length > 0) throw error;
      tx.reject(error.code);
      return undefined;
    }
  }

  private finishInbox(r: Repositories, delivery: { consumerName: string; messageId: string; payloadHash: string } | undefined,
    existing: InboxMessage | undefined, at: Date): void {
    if (!delivery || existing?.isProcessed()) return;
    const message = existing ?? InboxMessage.receive({ ...delivery, receivedAt: at });
    message.markProcessed(new Date(Math.max(at.getTime(), message.receivedAt.getTime())));
    if (existing) r.inbox.save(message); else r.inbox.add(message);
  }

  private enqueue(r: Repositories, tx: WagerTransaction, result: WagerResult, entry: WalletLedgerEntry | undefined, at: Date,
    correlationId = tx.id, messageId?: string): void {
    const add = (eventType: string, data: JsonObject): void => {
      const eventId = this.runtime.id();
      r.outbox.add(OutboxMessage.enqueue({ id: eventId, aggregateId: tx.walletId, eventType, occurredAt: at,
        payload: { eventId, eventType, version: 1, aggregateId: tx.walletId, correlationId,
          ...(messageId ? { messageId } : {}), providerId: tx.providerId, transactionId: tx.id,
          causationId: tx.externalTransactionId, occurredAt: at.toISOString(), data } }));
    };
    const eventType = tx.status === WagerTransactionStatus.Processed ? 'WagerTransactionProcessed'
      : tx.status === WagerTransactionStatus.PendingReference ? 'WagerTransactionPendingReference' : 'WagerTransactionRejected';
    add(eventType, { ...result, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId, kind: tx.kind, money: { ...tx.money.toJSON() } });
    if (entry) add('WalletBalanceChanged', { walletId: tx.walletId, transactionId: tx.id, ledgerEntryId: entry.id,
      direction: entry.direction, money: { ...entry.money.toJSON() }, balanceBefore: { ...entry.balanceBefore.toJSON() },
      balanceAfter: { ...entry.balanceAfter.toJSON() }, walletVersion: result.walletVersion });
  }
}
