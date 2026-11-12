import { expect, test } from 'bun:test';

import type { UnitOfWork } from '../../src/application/ports/persistence';
import type { WagerCommand } from '../../src/application/wagering/contracts';
import { RetryableTransactionError } from '../../src/application/wagering/contracts';
import { ProcessWager } from '../../src/application/wagering/process-wager';
import { FailureCode, WagerTransactionKind } from '../../src/domain';
import { SystemRuntime } from '../../src/infrastructure/system-runtime';

const command: WagerCommand = {
  providerId: 'provider',
  externalTransactionId: 'external',
  idempotencyKey: 'key',
  walletId: 'wallet',
  playerId: 'player',
  roundId: 'round',
  gameId: 'game',
  kind: WagerTransactionKind.Bet,
  money: { amount: '1.00', currency: 'BRL' },
};

test('retry is bounded to four attempts with exponential backoff and jitter', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const error = new RetryableTransactionError(new Error('rolled back'));
  const uow: UnitOfWork = {
    run: async () => {
      attempts += 1;
      throw error;
    },
  };
  const runtime = new SystemRuntime();
  runtime.pause = async (delay) => {
    delays.push(delay);
  };
  runtime.random = () => 0.5;
  await expect(new ProcessWager(uow, runtime).execute(command)).rejects.toBe(error);
  expect(attempts).toBe(4);
  expect(delays).toEqual([37, 62, 112]);
});

test('unknown/ambiguous commit errors are propagated without automatic retry', async () => {
  let attempts = 0;
  const error = new Error('connection lost during commit');
  const uow: UnitOfWork = {
    run: async () => {
      attempts += 1;
      throw error;
    },
  };
  await expect(new ProcessWager(uow, new SystemRuntime()).execute(command)).rejects.toBe(error);
  expect(attempts).toBe(1);
});

test('invalid payload/reference/key and OPENING are rejected before starting a transaction', async () => {
  let calls = 0;
  const uow: UnitOfWork = {
    run: async () => {
      calls += 1;
      throw new Error('Unexpected database call');
    },
  };
  const processor = new ProcessWager(uow, new SystemRuntime());
  await expect(processor.execute({ ...command, idempotencyKey: '' })).rejects.toMatchObject({
    code: FailureCode.InvalidPayload,
  });
  await expect(
    processor.execute({ ...command, money: { amount: '0.001', currency: 'BRL' } }),
  ).rejects.toMatchObject({ code: FailureCode.InvalidMoney });
  await expect(
    processor.execute({ ...command, kind: WagerTransactionKind.Refund }),
  ).rejects.toMatchObject({ code: FailureCode.InvalidReference });
  await expect(
    processor.execute({ ...command, kind: 'OPENING' as WagerCommand['kind'] }),
  ).rejects.toMatchObject({ code: FailureCode.InvalidPayload });
  expect(calls).toBe(0);
});
