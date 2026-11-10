import { expect, test } from 'bun:test';
import { DomainError, FailureCode, WagerTransactionStatus } from '../../src/domain';
import type { WagerResponse } from '../../src/application/wagering/contracts';
import { ConsumerWorker } from '../../src/infrastructure/messaging/consumer-worker';
import { messagingConfig } from '../../src/infrastructure/messaging/config';
import type { DispositionRecord, DispositionStore } from '../../src/infrastructure/messaging/dispositions';
import type { Delivery, QueueTransport } from '../../src/infrastructure/messaging/sqs';

const config = { ...messagingConfig({}), idleMs: 10, consumerConcurrency: 1, shutdownMs: 20 };
const message: Delivery = { id: 'message', receipt: 'receipt', group: 'wallet', receives: 1,
  body: JSON.stringify({ providerId: 'p', externalTransactionId: 'external', idempotencyKey: 'key', walletId: 'wallet',
    playerId: 'player', roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '1.00', currency: 'BRL' },
    delivery: { consumerName: 'forged', messageId: 'forged' } }) };
const response: WagerResponse = { transactionId: 'tx', status: WagerTransactionStatus.Processed,
  balance: { amount: '9.00', currency: 'BRL' }, walletVersion: 2, failureCode: null, idempotentReplay: false };
function fixture(execute: () => Promise<WagerResponse>) {
  const events: string[] = [];
  const records = new Map<string, DispositionRecord>();
  const store: DispositionStore = {
    find: async queue => records.get(queue),
    save: async (queue, _message, disposition, reason) => { events.push(`commit:${disposition}`); records.set(queue, { disposition, reason }); },
  };
  const transport: QueueTransport = {
    receive: async () => undefined,
    ack: async () => { events.push('ack'); },
    visibility: async (_queue, _message, seconds) => { events.push(`visibility:${seconds}`); },
    deadLetter: async () => { events.push('dlq'); },
    publish: async () => {},
  };
  const worker = new ConsumerWorker(transport, store, { execute: async command => {
    expect(command.delivery).toEqual({ consumerName: config.consumerName, messageId: message.id });
    return execute();
  } }, config);
  return { events, records, store, transport, worker };
}

test('ack waits for the use-case COMMIT promise; receipt metadata is trusted only from SQS', async () => {
  let commit!: (value: WagerResponse) => void;
  const f = fixture(() => new Promise(resolve => { commit = resolve; }));
  const running = f.worker.handle(config.queueName, message);
  await Bun.sleep(10);
  expect(f.events).toEqual([]);
  commit(response);
  await running;
  expect(f.events).toEqual(['ack']);
});

test('rollback/ambiguous commit retries without ack or terminal disposition', async () => {
  const f = fixture(async () => { throw new Error('connection lost at commit'); });
  await f.worker.handle(config.queueName, message);
  expect(f.records.size).toBe(0);
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toStartWith('visibility:');
});

test('terminal business error commits disposition before ack', async () => {
  const f = fixture(async () => { throw new DomainError(FailureCode.CurrencyMismatch, 'currency'); });
  await f.worker.handle(config.queueName, message);
  expect(f.events).toEqual(['commit:TERMINAL', 'ack']);
});

test('invalid JSON goes to DLQ only after durable disposition', async () => {
  const f = fixture(async () => { throw new Error('must not execute'); });
  await f.worker.handle(config.queueName, { ...message, body: '{' });
  expect(f.events).toEqual(['commit:DEAD_LETTER', 'dlq', 'ack']);
});

test('exhausted transient failures go to DLQ', async () => {
  const f = fixture(async () => { throw new Error('offline'); });
  await f.worker.handle(config.queueName, { ...message, receives: config.maxReceives });
  expect(f.events).toEqual(['commit:DEAD_LETTER', 'dlq', 'ack']);
});

test('failed DLQ publication retains source; retry resumes disposition without executing business logic', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new DomainError(FailureCode.IdempotencyConflict, 'conflict'); });
  f.transport.deadLetter = async () => { throw new Error('SQS offline'); };
  await f.worker.handle(config.queueName, message);
  expect(f.events).not.toContain('ack');
  f.transport.deadLetter = async () => { f.events.push('dlq'); };
  await f.worker.handle(config.queueName, message);
  expect(calls).toBe(1);
  expect(f.events.slice(-2)).toEqual(['dlq', 'ack']);
});

test('failed disposition commit cannot ack or forward', async () => {
  const f = fixture(async () => { throw new DomainError(FailureCode.CurrencyMismatch, 'currency'); });
  f.store.save = async () => { throw new Error('commit failed'); };
  await f.worker.handle(config.queueName, message);
  expect(f.events).not.toContain('ack');
  expect(f.events).not.toContain('dlq');
});

test('DLQ consumer archives before deletion and never executes a financial use case', async () => {
  const f = fixture(async () => { throw new Error('must not execute'); });
  await f.worker.handle(config.dlqName, message);
  expect(f.events).toEqual(['commit:QUARANTINED', 'ack']);
});

test('ack failure causes retry after successful commit', async () => {
  const f = fixture(async () => response);
  f.transport.ack = async () => { throw new Error('lost ack'); };
  await f.worker.handle(config.queueName, message);
  expect(f.events[0]).toStartWith('visibility:');
});

test('shutdown drains an in-flight message before returning', async () => {
  let commit!: (value: WagerResponse) => void;
  const f = fixture(() => new Promise(resolve => { commit = resolve; }));
  let delivered = false;
  f.transport.receive = async queue => {
    if (queue === config.queueName && !delivered) { delivered = true; return message; }
    return undefined;
  };
  f.worker.start();
  await Bun.sleep(5);
  const stopped = f.worker.stop();
  commit(response);
  await stopped;
  expect(f.events).toEqual(['ack']);
});

test('shutdown deadline releases visibility and forbids a late ack', async () => {
  let commit!: (value: WagerResponse) => void;
  const f = fixture(() => new Promise(resolve => { commit = resolve; }));
  let delivered = false;
  f.transport.receive = async queue => {
    if (queue === config.queueName && !delivered) { delivered = true; return message; }
    return undefined;
  };
  f.worker.start();
  await Bun.sleep(5);
  await f.worker.stop();
  expect(f.events).toEqual(['visibility:0']);
  commit(response);
  await Bun.sleep(5);
  expect(f.events).not.toContain('ack');
});
