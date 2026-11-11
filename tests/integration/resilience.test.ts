import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TestEnvironment, eventually, isolatedConfig } from '../support/environment';
import { startProcess } from '../support/process';
import { OutboxWorker } from '../../src/infrastructure/messaging/outbox-worker';
import { PendingReferenceWorker } from '../../src/infrastructure/messaging/pending-reference-worker';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/domain';
import { ProcessWager } from '../../src/application/wagering/process-wager';
import { SystemRuntime } from '../../src/infrastructure/system-runtime';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';

const suite = process.env['TEST_DATABASE_URL'] && process.env['TEST_SQS_ENDPOINT'] ? describe : describe.skip;
suite('Real process death, independent publishers and reference recovery', () => {
  let env: TestEnvironment;
  beforeEach(async () => { env = new TestEnvironment(); await env.start(); }, 30_000);
  afterEach(async () => { await env.close(); }, 15_000);

  test('SIGKILL after financial commit before ACK/publication; restarted Nest service recovers both', async () => {
    const wallet = await env.wallet();
    const input = env.command(wallet);
    const messageId = await env.send(input);
    const crashed = startProcess('tests/fixtures/crash-worker.ts', { ...env.childEnv(), CRASH_POINT: 'before-ack' });
    try {
      await crashed.ready('FAILURE_BOUNDARY_REACHED');
      await env.uow.run(async r => {
        expect((await r.wallets.findById(wallet.id))?.balance.amount).toBe('75.00');
        expect((await r.inbox.find(env.config.consumerName, messageId))?.isProcessed()).toBe(true);
        expect(await r.outbox.findDue(new Date(), 100)).toHaveLength(2);
      });
    } finally { await crashed.kill(); }
    // Natural visibility expiration, not a synthetic delivery or forced visibility change.
    const redelivery = await env.receive();
    expect(redelivery.id).toBe(messageId);
    expect(redelivery.receives).toBeGreaterThanOrEqual(2);
    await env.sqs.visibility(env.config.queueName, redelivery, 0);

    const restarted = startProcess('src/worker.ts', env.childEnv());
    try {
      await restarted.ready('Workers started');
      await eventually(async () => {
        const rows = await env.orm.em.fork().execute<{ count: number }[]>(
          'select count(*)::int as count from outbox_messages where published_at is not null');
        return rows[0]?.count === 2;
      });
      const eventIds = new Set<string>();
      for (let i = 0; i < 2; i++) {
        const event = await env.receive(env.config.eventsQueueName);
        const payload = JSON.parse(event.body) as { eventId: string; correlationId: string };
        eventIds.add(payload.eventId);
        expect(payload.correlationId).toBe((await env.processor.execute(input)).transactionId);
        await env.sqs.ack(env.config.eventsQueueName, event);
      }
      expect(eventIds.size).toBe(2);
      const { GetQueueAttributesCommand, GetQueueUrlCommand } = await import('@aws-sdk/client-sqs');
      const { QueueUrl } = await env.sqs.client.send(new GetQueueUrlCommand({ QueueName: env.config.queueName }));
      await eventually(async () => {
        const { Attributes } = await env.sqs.client.send(new GetQueueAttributesCommand({ QueueUrl: QueueUrl!,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
        return Attributes?.['ApproximateNumberOfMessages'] === '0' && Attributes['ApproximateNumberOfMessagesNotVisible'] === '0';
      });
      const replay = await env.processor.execute(input);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.balance.amount).toBe('75.00');
      await env.uow.run(async r => expect(await r.ledger.listByWallet(wallet.id, 0, 100)).toHaveLength(2));
    } finally { await restarted.kill(); }
  }, 40_000);

  test('SIGKILL after SQS send before outbox status commit releases the claim and republishes safely', async () => {
    const wallet = await env.wallet();
    await env.processor.execute(env.command(wallet));
    const crashed = startProcess('tests/fixtures/crash-worker.ts', { ...env.childEnv(), CRASH_POINT: 'after-publish' });
    let firstId: string;
    try {
      await crashed.ready('FAILURE_BOUNDARY_REACHED');
      const delivered = await env.receive(env.config.eventsQueueName);
      firstId = (JSON.parse(delivered.body) as { eventId: string }).eventId;
      await env.sqs.ack(env.config.eventsQueueName, delivered);
      const rows = await env.orm.em.fork().execute<{ published_at: Date | null }[]>(
        'select published_at from outbox_messages where id = ?', [firstId]);
      expect(rows[0]?.published_at).toBeNull();
    } finally { await crashed.kill(); }
    const publisher = new OutboxWorker(env.uow, env.sqs, env.runtime);
    let recovered = 0;
    while (await publisher.runOnce()) recovered++;
    expect(recovered).toBe(2);
    const second = await env.receive(env.config.eventsQueueName);
    expect((JSON.parse(second.body) as { eventId: string }).eventId).not.toBe(firstId!);
    await env.sqs.ack(env.config.eventsQueueName, second);
    expect(await env.sqs.receive(env.config.eventsQueueName, AbortSignal.timeout(3000))).toBeUndefined();
    await env.uow.run(async r => {
      expect((await r.outbox.findById(firstId!))?.publishedAt).toBeDefined();
      expect(await r.ledger.listByWallet(wallet.id, 0, 100)).toHaveLength(2);
    });
  }, 30_000);

  test('four independent publisher pools claim every outbox row and deliver every event to real SQS', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => env.wallet()));
    await Promise.all(wallets.map(wallet => env.processor.execute(env.command(wallet))));
    const pools: MikroORM[] = [];
    try {
      for (let i = 0; i < 4; i++) pools.push(await MikroORM.init(isolatedConfig(env.database, env.schema)));
      const counts = await Promise.all(pools.map(async pool => {
        const worker = new OutboxWorker(new MikroUnitOfWork(pool), env.sqs, env.runtime);
        let count = 0;
        while (await worker.runOnce()) count++;
        return count;
      }));
      expect(counts.reduce((a, b) => a + b, 0)).toBe(20);
      expect(counts.filter(count => count > 0).length).toBeGreaterThan(1);
      const rows = await env.orm.em.fork().execute<{ id: string; published_at: Date | null }[]>('select id, published_at from outbox_messages');
      expect(rows.every(row => row.published_at !== null)).toBe(true);
      const received: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const event = await env.receive(env.config.eventsQueueName);
        received.push((JSON.parse(event.body) as { eventId: string }).eventId);
        await env.sqs.ack(env.config.eventsQueueName, event);
      }
      expect(received.sort()).toEqual(rows.map(row => row.id).sort());
      expect(await env.sqs.receive(env.config.eventsQueueName, AbortSignal.timeout(3000))).toBeUndefined();
    } finally { await Promise.all(pools.map(pool => pool.close(true))); }
  }, 30_000);

  for (const kind of [Kind.Refund, Kind.Rollback] as const) {
    test(`${kind} before BET persists through backoff and worker recreation, then resolves automatically`, async () => {
      const wallet = await env.wallet();
      const bet = env.command(wallet);
      const reversal = env.command(wallet, { kind, referenceExternalTransactionId: bet.externalTransactionId });
      // Real SQS ingress for the out-of-order reference.
      const messageId = await env.send(reversal);
      const delivery = await env.receive();
      const { ConsumerWorker } = await import('../../src/infrastructure/messaging/consumer-worker');
      const { MikroDispositionStore } = await import('../../src/infrastructure/messaging/dispositions');
      await new ConsumerWorker(env.sqs, new MikroDispositionStore(env.orm), env.processor, env.config).handle(env.config.queueName, delivery);
      const original = await env.processor.execute(reversal);
      expect(original.status).toBe(Status.PendingReference);
      await env.uow.run(async r => expect((await r.inbox.find(env.config.consumerName, messageId))?.isProcessed()).toBe(true));
      let now = Date.now();
      const runtime = new SystemRuntime(); runtime.now = () => new Date(now);
      const config = { ...env.config, pendingBaseDelayMs: 100, pendingMaxDelayMs: 200, pendingTtlMs: 10_000 };
      const worker = new PendingReferenceWorker(new ProcessWager(env.uow, runtime), config);
      for (const [attempt, delay] of [[1, 100], [2, 200], [3, 200]] as const) {
        expect(await worker.runOnce()).toBe(true);
        const rows = await env.orm.em.fork().execute<{ attempts: number; next_attempt_at: Date }[]>(
          'select attempts, next_attempt_at from pending_reference_jobs where transaction_id = ?', [original.transactionId]);
        expect(rows[0]?.attempts).toBe(attempt);
        expect(new Date(rows[0]!.next_attempt_at).getTime()).toBe(now + delay);
        expect(await worker.runOnce()).toBe(false);
        now += delay;
      }
      await env.processor.execute(bet);
      const reopened = await MikroORM.init(isolatedConfig(env.database, env.schema));
      try {
        const recovered = new PendingReferenceWorker(new ProcessWager(new MikroUnitOfWork(reopened), runtime), config);
        expect(await recovered.runOnce()).toBe(true);
        expect(await recovered.runOnce()).toBe(false);
      } finally { await reopened.close(true); }
      await env.uow.run(async r => {
        expect((await r.transactions.findById(original.transactionId))?.status).toBe(Status.Processed);
        expect((await r.wallets.findById(wallet.id))?.balance.amount).toBe('100.00');
        expect(await r.ledger.listByWallet(wallet.id, 0, 100)).toHaveLength(3);
      });
      expect(await env.processor.execute(reversal)).toEqual(original);
    }, 20_000);

    test(`${kind} with missing reference expires automatically without a financial effect`, async () => {
      const wallet = await env.wallet();
      const pending = await env.processor.execute(env.command(wallet, { kind, referenceExternalTransactionId: 'missing' }));
      const runtime = new SystemRuntime(); runtime.now = () => new Date(Date.now() + 2000);
      const worker = new PendingReferenceWorker(new ProcessWager(env.uow, runtime), { ...env.config, pendingTtlMs: 1000 });
      expect(await worker.runOnce()).toBe(true);
      expect(await worker.runOnce()).toBe(false);
      await env.uow.run(async r => {
        const tx = await r.transactions.findById(pending.transactionId);
        expect(tx?.status).toBe(Status.Rejected);
        expect(tx?.failureCode).toBe(FailureCode.ReferenceExpired);
        expect(await r.ledger.listByWallet(wallet.id, 0, 100)).toHaveLength(1);
      });
    });
  }
});
