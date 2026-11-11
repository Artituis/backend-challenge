import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { assertLedgerInvariant } from '../support/invariant';
import { MikroORM } from '@mikro-orm/postgresql';
import { DeleteQueueCommand, GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Money, OutboxMessage, Wallet, WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/domain';
import type { UnitOfWork } from '../../src/application/ports/persistence';
import type { WagerCommand } from '../../src/application/wagering/contracts';
import { ProcessWager } from '../../src/application/wagering/process-wager';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { SystemRuntime } from '../../src/infrastructure/system-runtime';
import { messagingConfig } from '../../src/infrastructure/messaging/config';
import { SqsMessaging } from '../../src/infrastructure/messaging/sqs';
import type { Delivery } from '../../src/infrastructure/messaging/sqs';
import { decodeWager } from '../../src/infrastructure/messaging/decode';
import { provisionQueues } from '../../src/infrastructure/messaging/provision';
import { ConsumerWorker } from '../../src/infrastructure/messaging/consumer-worker';
import { MikroDispositionStore } from '../../src/infrastructure/messaging/dispositions';
import { OutboxWorker } from '../../src/infrastructure/messaging/outbox-worker';

const database = process.env['TEST_DATABASE_URL'];
const endpoint = process.env['TEST_SQS_ENDPOINT'];
const suite = database && endpoint ? describe : describe.skip;
const id = () => crypto.randomUUID();

suite('PostgreSQL + LocalStack delivery and recovery', () => {
  const suffix = id();
  const schema = `messaging_test_${suffix.replaceAll('-', '')}`;
  const config = { ...messagingConfig({}), endpoint: endpoint!, pollSeconds: 1,
    queueName: `test-${suffix}.fifo`, dlqName: `test-${suffix}-dlq.fifo`, eventsQueueName: `test-${suffix}-events.fifo` };
  let admin: MikroORM;
  let orm: MikroORM;
  let uow: MikroUnitOfWork;
  let processor: ProcessWager;
  let sqs: SqsMessaging;
  let store: MikroDispositionStore;
  let consumer: ConsumerWorker;
  let queueUrl: string;
  const runtime = new SystemRuntime();
  let now = Date.now();
  runtime.now = () => new Date(now);
  const policy = { ttlMs: 10000, baseDelayMs: 100, maxDelayMs: 1000 };

  afterEach(async () => { if (orm) await assertLedgerInvariant(orm); });

  beforeAll(async () => {
    if (!database || !new URL(database).pathname.endsWith('_test')) throw new Error('Requires _test database');
    admin = await MikroORM.init(persistenceConfig(database));
    await admin.em.getConnection().execute(`create schema ${schema}`);
    orm = await MikroORM.init({ ...persistenceConfig(database), schema,
      driverOptions: { connection: { options: `-c search_path=${schema}` } } });
    await orm.getMigrator().up();
    uow = new MikroUnitOfWork(orm);
    processor = new ProcessWager(uow, runtime);
    sqs = new SqsMessaging(config);
    await provisionQueues(sqs.client, config);
    await sqs.initialize();
    store = new MikroDispositionStore(orm);
    consumer = new ConsumerWorker(sqs, store, processor, config);
    queueUrl = (await sqs.client.send(new GetQueueUrlCommand({ QueueName: config.queueName }))).QueueUrl!;
  }, 30000);

  afterAll(async () => {
    if (sqs) {
      for (const name of [config.queueName, config.dlqName, config.eventsQueueName]) {
        const result = await sqs.client.send(new GetQueueUrlCommand({ QueueName: name }));
        await sqs.client.send(new DeleteQueueCommand({ QueueUrl: result.QueueUrl! }));
      }
      sqs.close();
    }
    if (orm) await orm.close(true);
    if (admin) { await admin.em.getConnection().execute(`drop schema if exists ${schema} cascade`); await admin.close(true); }
  });

  async function wallet(): Promise<Wallet> {
    const value = Wallet.open({ id: id(), playerId: id(), initialBalance: Money.from({ amount: '0.00', currency: 'BRL' }), at: runtime.now() });
    await uow.run(async r => { r.wallets.add(value); });
    await processor.execute(command(value, Kind.Win, '100.00'));
    return value;
  }
  function command(value: Wallet, kind: WagerCommand['kind'] = Kind.Bet, amount = '25.00', reference?: string): WagerCommand {
    const externalId = id();
    return { providerId: 'p', externalTransactionId: externalId, idempotencyKey: externalId,
      walletId: value.id, playerId: value.playerId, gameId: 'g', roundId: 'r', kind, money: { amount, currency: 'BRL' },
      ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }) };
  }
  async function send(body: string, group = id()): Promise<void> {
    await sqs.client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body,
      MessageGroupId: group, MessageDeduplicationId: id() }));
  }
  async function receive(queue = config.queueName): Promise<Delivery> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const message = await sqs.receive(queue, AbortSignal.timeout(5000));
      if (message) return message;
    }
    throw new Error('Expected delivery');
  }
  test('lost ack redelivers the same message; persistent inbox prevents a second debit', async () => {
    const value = await wallet(); const input = command(value);
    await send(JSON.stringify(input));
    const first = await receive();
    // Commit the real delivery and deliberately omit DeleteMessage.
    await processor.execute(decodeWager(first.body, config.consumerName, first.id));
    await sqs.visibility(config.queueName, first, 0);
    const again = await receive();
    expect(again.id).toBe(first.id);
    await consumer.handle(config.queueName, again);
    await uow.run(async r => {
      expect((await r.wallets.findById(value.id))?.balance.amount).toBe('75.00');
      expect((await r.inbox.find(config.consumerName, first.id))?.isProcessed()).toBe(true);
      expect(await r.ledger.listByWallet(value.id, 0, 100)).toHaveLength(2);
    });
  });

  test('same FIFO group is blocked until predecessor is deleted', async () => {
    const group = id();
    await send('{}', group); await send('{}', group);
    const first = await receive();
    expect(await sqs.receive(config.queueName, AbortSignal.timeout(5000))).toBeUndefined();
    await sqs.ack(config.queueName, first);
    const second = await receive();
    expect(second.id).not.toBe(first.id);
    await sqs.ack(config.queueName, second);
  }, 10000);

  test('permanent poison payload is forwarded, archived from DLQ and acknowledged', async () => {
    await send('{broken');
    const message = await receive();
    await consumer.handle(config.queueName, message);
    expect((await store.find(config.queueName, message))?.disposition).toBe('DEAD_LETTER');
    const dead = await receive(config.dlqName);
    expect(dead.body).toBe(message.body);
    await consumer.handle(config.dlqName, dead);
    expect((await store.find(config.dlqName, dead))?.disposition).toBe('QUARANTINED');
  });

  test('broker redrive still works when a consumer crashes without recording a disposition', async () => {
    await send('{native-redrive');
    for (let attempt = 0; attempt < config.maxReceives; attempt++) {
      const message = await receive();
      await sqs.visibility(config.queueName, message, 0);
    }
    expect(await sqs.receive(config.queueName, AbortSignal.timeout(5000))).toBeUndefined();
    const dead = await receive(config.dlqName);
    expect(dead.body).toBe('{native-redrive');
    await consumer.handle(config.dlqName, dead);
  }, 15000);

  test('pending reference backoff, competing workers, financial completion and immutable replay', async () => {
    const value = await wallet(); const bet = command(value);
    const refund = command(value, Kind.Refund, '25.00', bet.externalTransactionId);
    const accepted = await processor.execute(refund);
    expect(accepted.status).toBe(Status.PendingReference);
    await processor.reprocessNextPending(policy);
    const jobs = await orm.em.fork().execute<{ attempts: number; next_attempt_at: Date }[]>(
      'select attempts, next_attempt_at from pending_reference_jobs where transaction_id = ?', [accepted.transactionId]);
    expect(jobs[0]?.attempts).toBe(1);
    expect(new Date(jobs[0]!.next_attempt_at).getTime()).toBe(now + 100);
    expect(await processor.reprocessNextPending(policy)).toBe(false);
    await processor.execute(bet);
    now += 100;
    const outcomes = await Promise.all(Array.from({ length: 3 }, () => processor.reprocessNextPending(policy)));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await uow.run(async r => {
      expect((await r.transactions.findById(accepted.transactionId))?.status).toBe(Status.Processed);
      expect((await r.wallets.findById(value.id))?.balance.amount).toBe('100.00');
      expect(await r.ledger.listByWallet(value.id, 0, 100)).toHaveLength(3);
    });
    expect(await processor.execute(refund)).toEqual({ ...accepted, idempotentReplay: true });
  });

  test('TTL expiration is REJECTED with a dedicated code and no financial movement', async () => {
    const value = await wallet();
    const pending = await processor.execute(command(value, Kind.Rollback, '25.00', 'never-arrives'));
    now += policy.ttlMs;
    await processor.reprocessNextPending(policy);
    await uow.run(async r => {
      const tx = await r.transactions.findById(pending.transactionId);
      expect(tx?.status).toBe(Status.Rejected);
      expect(tx?.failureCode).toBe(FailureCode.ReferenceExpired);
      expect((await r.wallets.findById(value.id))?.balance.amount).toBe('100.00');
      expect(await r.ledger.listByWallet(value.id, 0, 100)).toHaveLength(1);
    });
  });

  test('real broker queue disappearance persists outbox backoff and recovery publishes', async () => {
    // Drain events left by preceding financial scenarios.
    const worker = new OutboxWorker(uow, sqs, runtime);
    let drained = 0;
    while (await worker.runOnce()) drained++;
    for (let i = 0; i < drained; i++) {
      const message = await receive(config.eventsQueueName);
      await sqs.ack(config.eventsQueueName, message);
    }
    const event = OutboxMessage.enqueue({ id: id(), aggregateId: 'test', eventType: 'Test', payload: { eventId: id() }, occurredAt: runtime.now() });
    await uow.run(async r => { r.outbox.add(event); });
    const { QueueUrl } = await sqs.client.send(new GetQueueUrlCommand({ QueueName: config.eventsQueueName }));
    await sqs.client.send(new DeleteQueueCommand({ QueueUrl: QueueUrl! }));
    try { expect(await worker.runOnce()).toBe(true); }
    finally { await provisionQueues(sqs.client, config); await sqs.initialize(); }
    await uow.run(async r => {
      const loaded = await r.outbox.findById(event.id);
      expect(loaded?.attempts).toBe(1);
      expect(loaded?.nextAttemptAt?.getTime()).toBe(now + 1000);
      expect(loaded?.publishedAt).toBeUndefined();
    });
    expect(await worker.runOnce()).toBe(false);
    now += 1000;
    await worker.runOnce();
    const delivered = await receive(config.eventsQueueName);
    expect(JSON.parse(delivered.body)).toEqual(event.payload);
    await sqs.ack(config.eventsQueueName, delivered);
  }, 30_000);

  test('publish then SQL rollback recovers the event; stable SQS dedup ID suppresses immediate duplicate', async () => {
    const eventId = id();
    const event = OutboxMessage.enqueue({ id: eventId, aggregateId: id(), eventType: 'Crash', payload: { eventId }, occurredAt: runtime.now() });
    await uow.run(async r => { r.outbox.add(event); });
    const failing: UnitOfWork = { run: work => uow.run(async r => { await work(r); throw new Error('crash before commit'); }) };
    await expect(new OutboxWorker(failing, sqs, runtime).runOnce()).rejects.toThrow('crash before commit');
    await new OutboxWorker(uow, sqs, runtime).runOnce();
    const delivered = await receive(config.eventsQueueName);
    expect(JSON.parse(delivered.body).eventId).toBe(eventId);
    await sqs.ack(config.eventsQueueName, delivered);
    expect(await sqs.receive(config.eventsQueueName, AbortSignal.timeout(5000))).toBeUndefined();
    await uow.run(async r => expect((await r.outbox.findById(event.id))?.publishedAt).toBeDefined());
  }, 10000);

  test('Nest worker boots and exits on SIGTERM with long polls in flight', async () => {
    const connection = new URL(database!);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    const child = Bun.spawn([process.execPath, 'src/worker.ts'], { stdout: 'pipe', stderr: 'pipe', env: {
      ...process.env, DATABASE_URL: connection.toString(), SQS_ENDPOINT: endpoint!,
      SQS_QUEUE_NAME: config.queueName, SQS_DLQ_NAME: config.dlqName, SQS_EVENTS_QUEUE_NAME: config.eventsQueueName,
    } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stderr = new Response(child.stderr).text();
    try {
      const ready = (async () => {
        let output = '';
        for await (const chunk of child.stdout) {
          output += new TextDecoder().decode(chunk);
          if (output.includes('Workers started')) return;
        }
        throw new Error(`Worker failed to boot: ${output} ${await stderr}`);
      })();
      await Promise.race([ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Worker startup timed out')), 10000);
      })]);
      clearTimeout(timer);
      child.kill('SIGTERM');
      const exitCode = await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Worker shutdown timed out')), 5000);
      })]);
      expect([0, 143]).toContain(exitCode);
      expect(await stderr).not.toContain('Error');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    }
  }, 20000);
});
