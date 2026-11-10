import { InboxMessage, Money, OutboxMessage, WagerTransaction, Wallet, WalletLedgerEntry } from '../../domain';
import type { InboxRow, OutboxRow, WagerTransactionRow, WalletLedgerRow, WalletRow } from './entities';

export const walletMapper = {
  toRow(wallet: Wallet): WalletRow {
    return { id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
      balance: wallet.balance.amount, version: wallet.version, createdAt: wallet.createdAt, updatedAt: wallet.updatedAt };
  },
  toDomain(row: WalletRow): Wallet {
    return Wallet.rehydrate({ ...row, balance: Money.from({ amount: row.balance, currency: row.currency }) });
  },
};
export const transactionMapper = {
  toRow(tx: WagerTransaction): WagerTransactionRow {
    return { id: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey, payloadHash: tx.payloadHash, walletId: tx.walletId,
      playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind,
      amount: tx.money.amount, currency: tx.money.currency, createdAt: tx.createdAt,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      status: tx.status, referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null, processedAt: tx.processedAt ?? null };
  },
  toDomain(row: WagerTransactionRow): WagerTransaction {
    const { amount, currency, referenceExternalTransactionId, referenceTransactionId, failureCode, processedAt, ...state } = row;
    return WagerTransaction.rehydrate({ ...state, money: Money.from({ amount, currency }),
      ...(referenceExternalTransactionId === null ? {} : { referenceExternalTransactionId }),
      ...(referenceTransactionId === null ? {} : { referenceTransactionId }),
      ...(failureCode === null ? {} : { failureCode }), ...(processedAt === null ? {} : { processedAt }) });
  },
};
export const ledgerMapper = {
  toRow(entry: WalletLedgerEntry, walletVersion: number): WalletLedgerRow {
    return { id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId, walletVersion,
      direction: entry.direction, amount: entry.money.amount, currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount, balanceAfter: entry.balanceAfter.amount, createdAt: entry.createdAt };
  },
  toDomain(row: WalletLedgerRow): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({ id: row.id, walletId: row.walletId, transactionId: row.transactionId,
      direction: row.direction, money: Money.from({ amount: row.amount, currency: row.currency }),
      balanceBefore: Money.from({ amount: row.balanceBefore, currency: row.currency }),
      balanceAfter: Money.from({ amount: row.balanceAfter, currency: row.currency }), createdAt: row.createdAt });
  },
};
export const inboxMapper = {
  toRow(message: InboxMessage): InboxRow {
    return { consumerName: message.consumerName, messageId: message.messageId, payloadHash: message.payloadHash,
      receivedAt: message.receivedAt, processedAt: message.processedAt ?? null };
  },
  toDomain(row: InboxRow): InboxMessage {
    const { processedAt, ...state } = row;
    return InboxMessage.rehydrate({ ...state, ...(processedAt === null ? {} : { processedAt }) });
  },
};
export const outboxMapper = {
  toRow(message: OutboxMessage): OutboxRow {
    return { id: message.id, aggregateId: message.aggregateId, eventType: message.eventType,
      payload: message.payload, occurredAt: message.occurredAt, attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null, publishedAt: message.publishedAt ?? null };
  },
  toDomain(row: OutboxRow): OutboxMessage {
    const { nextAttemptAt, publishedAt, ...state } = row;
    return OutboxMessage.rehydrate({ ...state, ...(nextAttemptAt === null ? {} : { nextAttemptAt }),
      ...(publishedAt === null ? {} : { publishedAt }) });
  },
};
