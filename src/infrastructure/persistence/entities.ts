import { BigIntType, EntitySchema } from '@mikro-orm/core';
import type { FailureCode, JsonObject, LedgerDirection, WagerTransactionKind, WagerTransactionStatus } from '../../domain';
import { DecimalStringType } from './decimal-string.type';

export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export class WagerTransactionRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  createdAt!: Date;
  status!: WagerTransactionStatus;
  referenceTransactionId!: string | null;
  failureCode!: FailureCode | null;
  processedAt!: Date | null;
}
export class WalletLedgerRow {
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: number;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}
export class InboxRow {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}
export class OutboxRow {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: JsonObject;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

const text = { type: 'string', columnType: 'text' } as const;
const timestamp = { type: Date, columnType: 'timestamptz', length: 3 } as const;
const decimal = { type: DecimalStringType, columnType: 'numeric' } as const;
// bigint is safe for domain counters only while bounded by MAX_SAFE_INTEGER in SQL.
const counter = { type: new BigIntType('number') } as const;

export const WalletSchema = new EntitySchema<WalletRow>({
  class: WalletRow, tableName: 'wallets',
  properties: {
    id: { ...text, primary: true }, playerId: text, currency: text, balance: decimal,
    version: counter, createdAt: timestamp, updatedAt: timestamp,
  },
  uniques: [{ name: 'wallets_player_currency_unique', properties: ['playerId', 'currency'] }],
});
export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  class: WagerTransactionRow, tableName: 'wager_transactions',
  properties: {
    id: { ...text, primary: true }, providerId: text, externalTransactionId: text,
    idempotencyKey: text, payloadHash: text, walletId: text, playerId: text,
    roundId: text, gameId: text, kind: text, amount: decimal, currency: text,
    referenceExternalTransactionId: { ...text, nullable: true }, createdAt: timestamp,
    status: text, referenceTransactionId: { ...text, nullable: true },
    failureCode: { ...text, nullable: true }, processedAt: { ...timestamp, nullable: true },
  },
  uniques: [
    { name: 'wagers_provider_external_unique', properties: ['providerId', 'externalTransactionId'] },
    { name: 'wagers_provider_idempotency_unique', properties: ['providerId', 'idempotencyKey'] },
  ],
});
export const WalletLedgerSchema = new EntitySchema<WalletLedgerRow>({
  class: WalletLedgerRow, tableName: 'wallet_ledger_entries',
  properties: {
    id: { ...text, primary: true }, walletId: text, transactionId: text, walletVersion: counter,
    direction: text, amount: decimal, currency: text, balanceBefore: decimal,
    balanceAfter: decimal, createdAt: timestamp,
  },
  uniques: [
    { name: 'ledger_wallet_transaction_unique', properties: ['walletId', 'transactionId'] },
    { name: 'ledger_wallet_version_unique', properties: ['walletId', 'walletVersion'] },
  ],
});
export const InboxSchema = new EntitySchema<InboxRow>({
  class: InboxRow, tableName: 'inbox_messages',
  properties: {
    consumerName: { ...text, primary: true }, messageId: { ...text, primary: true },
    payloadHash: text, receivedAt: timestamp, processedAt: { ...timestamp, nullable: true },
  },
});
export const OutboxSchema = new EntitySchema<OutboxRow>({
  class: OutboxRow, tableName: 'outbox_messages',
  properties: {
    id: { ...text, primary: true }, aggregateId: text, eventType: text,
    payload: { type: 'json', columnType: 'jsonb' }, occurredAt: timestamp, attempts: counter,
    nextAttemptAt: { ...timestamp, nullable: true }, publishedAt: { ...timestamp, nullable: true },
  },
});
export const persistenceEntities = [WalletSchema, WagerTransactionSchema, WalletLedgerSchema, InboxSchema, OutboxSchema];
