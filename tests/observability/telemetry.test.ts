import { expect, test } from 'bun:test';

import { RetryableTransactionError } from '../../src/application/wagering/contracts';
import { ProcessWager } from '../../src/application/wagering/process-wager';
import { WagerTransactionKind } from '../../src/domain';
import { HealthService } from '../../src/infrastructure/health/health.module';
import { httpHandler } from '../../src/infrastructure/http/server';
import {
  bindTrace,
  JsonLogger,
  Metrics,
  trace,
  withTrace,
} from '../../src/infrastructure/observability/telemetry';
import { SystemRuntime } from '../../src/infrastructure/system-runtime';

test('Pino preserves the worker readiness event used by process supervisors', () => {
  const lines: string[] = [];
  new JsonLogger((line) => {
    lines.push(line);
  }).event('Workers started');
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'Workers started' });
});

test('JSON logs project allowed metadata and discard financial bodies, credentials and raw exceptions', () => {
  const lines: string[] = [];
  const logger = new JsonLogger((line) => {
    lines.push(line);
  });
  withTrace({ correlationId: 'corr-1', walletId: 'wallet-1', providerId: 'provider-1' }, () => {
    logger.event('http_completed', {
      status: '200',
      body: { amount: '999.99' },
      authorization: 'Bearer SECRET',
      password: 'PRIVATE',
      error: new Error('postgres://SECRET'),
    } as Parameters<JsonLogger['event']>[1]);
    logger.error(new Error('secret payload 999.99'), 'Bearer SECRET');
  });
  for (const line of lines) {
    expect(line).not.toMatch(/SECRET|PRIVATE|999\.99|password|authorization|postgres/);
    expect(JSON.parse(line)).toMatchObject({
      correlationId: 'corr-1',
      walletId: 'wallet-1',
      messageId: null,
      transactionId: null,
    });
  }
  withTrace({ correlationId: '{"secret":"value"}\n' }, () => logger.event('http_completed'));
  expect(lines.at(-1)).not.toContain('secret');
});

test('parallel asynchronous requests isolate identifiers and restore the caller context', async () => {
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      withTrace({ correlationId: `req-${i}` }, async () => {
        await Bun.sleep(i % 3);
        bindTrace({ transactionId: `tx-${i}` });
        await Bun.sleep(1);
        expect(trace()).toEqual({ correlationId: `req-${i}`, transactionId: `tx-${i}` });
      }),
    ),
  );
  expect(trace()).toEqual({});
});

test('Prometheus histograms are cumulative and series remain bounded', () => {
  const collector = new Metrics();
  collector.observe('http_processing', 0.01);
  collector.observe('http_processing', 1);
  collector.observe('http_processing', NaN);
  collector.transaction('PROCESSED');
  collector.transaction('attacker-controlled-label');
  collector.increment('duplicates');
  const text = collector.render();
  expect(text).toContain('wagering_http_processing_seconds_bucket{le="0.01"} 1');
  expect(text).toContain('wagering_http_processing_seconds_bucket{le="1"} 2');
  expect(text).toContain('wagering_http_processing_seconds_sum 1.01');
  expect(text).toContain('wagering_transactions_total{status="FAILED"} 0');
  expect(text).not.toContain('attacker');
});

test('health bypasses identity; readiness actively rechecks each dependency and live survives failure', async () => {
  let databaseUp = true;
  let queueUp = true;
  let dbCalls = 0;
  const health = new HealthService(
    async () => {
      dbCalls++;
      if (!databaseUp) throw new Error('credential');
    },
    async () => {
      if (!queueUp) throw new Error('secret');
    },
  );
  const handler = httpHandler(health, {
    handle: async () => {
      throw new Error('auth required');
    },
  });
  const get = (path: string) => handler(new Request(`http://localhost${path}`));
  expect((await get('/health/ready')).status).toBe(200);
  databaseUp = false;
  const down = await get('/health/ready');
  expect(down.status).toBe(503);
  expect(await down.json()).toEqual({
    status: 'unavailable',
    dependencies: { postgres: 'down', sqs: 'up' },
  });
  databaseUp = true;
  queueUp = false;
  expect((await get('/health/ready')).status).toBe(503);
  queueUp = true;
  expect((await get('/health/ready')).status).toBe(200);
  expect(dbCalls).toBe(4);
  databaseUp = queueUp = false;
  expect((await get('/health/live')).status).toBe(200);
  expect(dbCalls).toBe(4);
});

test('readiness times out stalled probes and coalesces simultaneous requests', async () => {
  let calls = 0;
  const health = new HealthService(
    () => {
      calls++;
      return new Promise(() => {});
    },
    async () => {},
    20,
  );
  const start = performance.now();
  const results = await Promise.all([health.ready(), health.ready(), health.ready()]);
  expect(calls).toBe(1);
  expect(results.every((result) => result.status === 'unavailable')).toBe(true);
  expect(performance.now() - start).toBeLessThan(1000);
  await health.ready();
  expect(calls).toBe(1); // A hung pool acquisition is reused, not multiplied after every deadline.
});

test('rolled-back attempts emit retries but never committed transaction metrics', async () => {
  let committed = 0;
  let retries = 0;
  const runtime = new SystemRuntime();
  runtime.pause = async () => {};
  const processor = new ProcessWager(
    {
      run: async () => {
        throw new RetryableTransactionError('rollback');
      },
    },
    runtime,
    {
      committed: () => {
        committed++;
      },
      retry: () => {
        retries++;
      },
    },
  );
  await expect(
    processor.execute({
      providerId: 'provider',
      externalTransactionId: 'external',
      idempotencyKey: 'key',
      walletId: 'wallet',
      playerId: 'player',
      roundId: 'round',
      gameId: 'game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '1.00', currency: 'BRL' },
    }),
  ).rejects.toBeInstanceOf(RetryableTransactionError);
  expect(committed).toBe(0);
  expect(retries).toBe(3);
});
