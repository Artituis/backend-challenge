import { DeleteQueueCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { ProcessWager } from '../../src/application/wagering/process-wager';
import { HealthService } from '../../src/infrastructure/health/health.module';
import { Api } from '../../src/infrastructure/http/api';
import { createHttpApplication } from '../../src/infrastructure/http/bootstrap';
import { ApiController } from '../../src/infrastructure/http/controller';
import { NoopProviderIdentity } from '../../src/infrastructure/http/identity';
import { httpHandler } from '../../src/infrastructure/http/server';
import { provisionQueues } from '../../src/infrastructure/messaging/provision';
import { LoggingModule } from '../../src/infrastructure/observability/logging.module';
import { wagerObserver } from '../../src/infrastructure/observability/telemetry';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { id, TestEnvironment } from '../support/environment';

const suite =
  process.env['TEST_DATABASE_URL'] && process.env['TEST_SQS_ENDPOINT'] ? describe : describe.skip;
suite('HTTP API, telemetry and active readiness against PostgreSQL/SQS', () => {
  let env: TestEnvironment;
  let server: NestExpressApplication;
  let baseUrl: string;
  beforeAll(async () => {
    env = new TestEnvironment();
    await env.start();
    const health = new HealthService(
      () => env.orm.em.getConnection().getKnex().raw('select 1').timeout(2000, { cancel: true }),
      (signal) => env.sqs.probe(signal),
    );
    const processor = new ProcessWager(env.uow, env.runtime, wagerObserver);
    class IntegrationHttpModule {}
    Module({
      imports: [LoggingModule],
      controllers: [ApiController],
      providers: [
        { provide: HealthService, useValue: health },
        {
          provide: Api,
          useValue: new Api(env.orm, env.uow, processor, new NoopProviderIdentity()),
        },
      ],
    })(IntegrationHttpModule);
    server = await createHttpApplication(IntegrationHttpModule);
    await server.listen(0, '127.0.0.1');
    baseUrl = await server.getUrl();
  }, 30_000);
  afterAll(async () => {
    await server?.close();
    await env?.close();
  }, 15_000);
  const request = (path: string, body?: unknown, key?: string) =>
    fetch(new URL(path, baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'http-integration',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('wallet opening, replay, conflict, ledger pagination and reconciliation use real commits', async () => {
    const playerId = id();
    const payload = { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } };
    const created = await request('/wallets', payload);
    expect(created.status).toBe(201);
    expect(created.headers.get('x-correlation-id')).toBe('http-integration');
    const wallet = (await created.json()) as { id: string };
    expect((await request('/wallets', payload)).status).toBe(409);
    const command = {
      providerId: 'http-provider',
      externalTransactionId: id(),
      walletId: wallet.id,
      playerId,
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    };
    const key = id();
    expect((await request('/wagering/transactions', command)).status).toBe(400);
    const result = await request('/wagering/transactions', command, key);
    expect(result.status).toBe(200);
    const accepted = (await result.json()) as {
      transactionId: string;
      balance: { amount: string };
    };
    expect(accepted.balance.amount).toBe('20.00');
    expect(await (await request('/wagering/transactions', command, key)).json()).toMatchObject({
      idempotentReplay: true,
      balance: { amount: '20.00' },
    });
    expect(
      (
        await request(
          '/wagering/transactions',
          { ...command, money: { amount: '1.00', currency: 'BRL' } },
          key,
        )
      ).status,
    ).toBe(409);
    expect(
      (await request('/wagering/transactions', { ...command, externalTransactionId: id() }, id()))
        .status,
    ).toBe(422);
    const page = (await (await request(`/wallets/${wallet.id}/ledger?limit=1`)).json()) as {
      entries: unknown[];
      nextCursor: string;
    };
    expect(page.entries).toHaveLength(1);
    expect(
      await (await request(`/wallets/${wallet.id}/ledger?cursor=${page.nextCursor}`)).json(),
    ).toMatchObject({ entries: [{ direction: 'DEBIT' }], nextCursor: null });
    expect(await (await request(`/wallets/${wallet.id}/reconciliation`, {})).json()).toMatchObject({
      consistent: true,
      storedBalance: { amount: '20.00' },
      checkedEntries: '2',
    });
    expect(
      await (await request(`/wagering/transactions/${accepted.transactionId}`)).json(),
    ).toMatchObject({ status: 'PROCESSED' });
    const events = await env.orm.em
      .fork()
      .execute<{ payload: Record<string, unknown> }[]>(
        "select payload from outbox_messages where payload->>'transactionId' = ?",
        [accepted.transactionId],
      );
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.payload['correlationId'] === 'http-integration')).toBe(
      true,
    );
    expect(await (await request('/metrics')).text()).toContain(
      'wagering_transactions_total{status="PROCESSED"} 1',
    );
  });

  test('readiness detects a deleted queue despite cached URL; liveness and restored readiness remain available', async () => {
    expect((await request('/health/ready')).status).toBe(200);
    const { QueueUrl } = await env.sqs.client.send(
      new GetQueueUrlCommand({ QueueName: env.config.eventsQueueName }),
    );
    await env.sqs.client.send(new DeleteQueueCommand({ QueueUrl: QueueUrl! }));
    try {
      expect((await request('/health/ready')).status).toBe(503);
      expect((await request('/health/live')).status).toBe(200);
    } finally {
      await provisionQueues(env.sqs.client, env.config);
    }
    expect((await request('/health/ready')).status).toBe(200);
  });

  test('pending-reference completion preserves the originating correlation in persisted events', async () => {
    const wallet = await env.wallet();
    const referenceId = id();
    const { idempotencyKey, ...refund } = {
      ...env.command(wallet),
      kind: 'REFUND',
      referenceExternalTransactionId: referenceId,
    };
    const response = await request('/wagering/transactions', refund, idempotencyKey);
    expect(response.status).toBe(202);
    const pending = (await response.json()) as { transactionId: string };
    await env.processor.execute(env.command(wallet, { externalTransactionId: referenceId }));
    await env.processor.reprocessNextPending({ ttlMs: 86400000, baseDelayMs: 1, maxDelayMs: 100 });
    const events = await env.orm.em
      .fork()
      .execute<{ correlation: string }[]>(
        "select payload->>'correlationId' as correlation from outbox_messages where payload->>'transactionId' = ?",
        [pending.transactionId],
      );
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.correlation === 'http-integration')).toBe(true);
    expect(
      await (await request(`/wagering/transactions/${pending.transactionId}`)).json(),
    ).toMatchObject({ status: 'PROCESSED' });
    expect((await request('/wagering/transactions', refund, idempotencyKey)).status).toBe(202);
  });

  test('readiness fails on an actual refused PostgreSQL connection while live stays available', async () => {
    const database = new URL(env.database);
    database.hostname = '127.0.0.1';
    database.port = '1';
    const orm = await MikroORM.init({ ...persistenceConfig(database.toString()), connect: false });
    const handler = httpHandler(
      new HealthService(
        () => orm.em.getConnection().getKnex().raw('select 1').timeout(2000, { cancel: true }),
        (signal) => env.sqs.probe(signal),
      ),
    );
    try {
      const response = await handler(new Request('http://localhost/health/ready'));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        dependencies: { postgres: 'down', sqs: 'up' },
      });
      expect((await handler(new Request('http://localhost/health/live'))).status).toBe(200);
    } finally {
      await orm.close(true);
    }
  });
});
