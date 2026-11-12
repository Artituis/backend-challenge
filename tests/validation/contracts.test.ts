import { expect, test } from 'bun:test';

import {
  classify,
  decodeWager,
  InvalidEnvelopeError,
} from '../../src/infrastructure/messaging/decode';
import {
  createWalletSchema,
  ledgerQuerySchema,
  submitTransactionSchema,
  transactionHeadersSchema,
} from '../../src/infrastructure/validation/contracts';

const wager = {
  providerId: 'provider',
  externalTransactionId: 'tx-1',
  walletId: 'wallet',
  playerId: 'player',
  roundId: 'round',
  gameId: 'game',
  kind: 'BET',
  money: { amount: '1.00', currency: 'BRL' },
};
test('shared contracts reject non-string money, precision loss, unknown fields and missing identifiers', () => {
  expect(submitTransactionSchema.safeParse(wager).success).toBe(true);
  for (const amount of [1, '1e3', 'NaN', '0.001', '1234567890123456789.00']) {
    expect(
      submitTransactionSchema.safeParse({ ...wager, money: { amount, currency: 'BRL' } }).success,
    ).toBe(false);
  }
  for (const input of [
    { ...wager, unexpected: true },
    { ...wager, kind: 'OPENING' },
    { ...wager, walletId: '' },
    { ...wager, money: { ...wager.money, secret: true } },
    null,
    [],
  ]) {
    expect(submitTransactionSchema.safeParse(input).success).toBe(false);
  }
  expect(
    createWalletSchema.safeParse({ playerId: 'player', initialBalance: wager.money }).success,
  ).toBe(true);
  expect(
    createWalletSchema.safeParse({ playerId: 'player', initialBalance: wager.money, balance: 100 })
      .success,
  ).toBe(false);
});
test('SQS rejects malformed envelopes and forged delivery metadata before processing', () => {
  const input = { ...wager, idempotencyKey: 'key', correlationId: 'corr' };
  expect(decodeWager(JSON.stringify(input), 'consumer', 'broker-id')).toMatchObject({
    correlationId: 'corr',
    delivery: { consumerName: 'consumer', messageId: 'broker-id' },
  });
  for (const body of [
    '{',
    'null',
    JSON.stringify({ ...input, delivery: { messageId: 'forged' } }),
    JSON.stringify({ ...input, correlationId: '\nsecret' }),
    JSON.stringify({ ...input, money: { amount: 1, currency: 'BRL' } }),
  ]) {
    expect(() => decodeWager(body, 'consumer', 'broker-id')).toThrow(InvalidEnvelopeError);
  }
  expect(classify(new InvalidEnvelopeError())).toBe('permanent');
});
test('idempotency and pagination contracts reject missing or ambiguous values', () => {
  for (const key of [undefined, '', 'a b', 'a'.repeat(129)]) {
    expect(transactionHeadersSchema.safeParse({ 'idempotency-key': key }).success).toBe(false);
  }
  for (const limit of ['0', '1001', '1.5', '', '1e2'])
    expect(ledgerQuerySchema.safeParse({ limit }).success).toBe(false);
  expect(ledgerQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
});
