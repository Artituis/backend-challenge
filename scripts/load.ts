import 'reflect-metadata';
import { mkdir } from 'node:fs/promises';
import { cpus, totalmem, platform, arch } from 'node:os';
import { NestFactory } from '@nestjs/core';
import { TestEnvironment } from '../tests/support/environment';
import { assertLedgerInvariant } from '../tests/support/invariant';
import { WageringModule } from '../src/infrastructure/wagering.module';
import { ProcessWager } from '../src/application/wagering/process-wager';
import type { WagerResponse } from '../src/application/wagering/contracts';
import { ConsumerWorker } from '../src/infrastructure/messaging/consumer-worker';
import { MikroDispositionStore } from '../src/infrastructure/messaging/dispositions';
import { OutboxWorker } from '../src/infrastructure/messaging/outbox-worker';
import { WorkerLoop } from '../src/infrastructure/messaging/loop';
import { decodeWager } from '../src/infrastructure/messaging/decode';

function integer(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const duration = integer('LOAD_DURATION_SECONDS', 30, 3600);
const concurrency = integer('LOAD_CONCURRENCY', 20, 200);
const walletCount = integer('LOAD_WALLETS', 20, 1000);
const maxRequests = integer('LOAD_MAX_REQUESTS', 10000, 1000000);
const drainSeconds = integer('LOAD_DRAIN_SECONDS', 120, 3600);
const percentile = (values: number[], fraction: number): number | null => {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]!;
};
const distribution = (values: number[]) => ({ samples: values.length,
  p50: percentile(values, 0.50), p95: percentile(values, 0.95), p99: percentile(values, 0.99) });
const env = new TestEnvironment();
env.config.visibilitySeconds = 30;
env.config.requestTimeoutMs = 5000;
await env.start();
process.env['DATABASE_URL'] = env.database;
process.env['PGOPTIONS'] = `-c search_path=${env.schema}`;
const app = await NestFactory.createApplicationContext(WageringModule, { logger: false });
const processor = app.get(ProcessWager);
// This is an HTTP benchmark adapter, not the production API (auth/controllers are a later phase).
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/wagers') return new Response(null, { status: 404 });
  try {
    const { delivery, ...command } = decodeWager(await request.text(), 'http-load', crypto.randomUUID());
    void delivery;
    return Response.json(await processor.execute(command));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
} });
const consumer = new ConsumerWorker(env.sqs, new MikroDispositionStore(env.orm), processor,
  { ...env.config, consumerConcurrency: Math.min(concurrency, 32) });
const publishers = Array.from({ length: 4 }, (_, i) => {
  const publisher = new OutboxWorker(env.uow, env.sqs, env.runtime);
  return new WorkerLoop(`LoadPublisher:${i}`, () => publisher.runOnce(), 10);
});
const httpMs: number[] = [];
const sqsSendMs: number[] = [];
const sqsCompletionMs: number[] = [];
const lagMs: number[] = [];
const pending = new Map<string, number>();
const failures: string[] = [];
let attempted = 0;
let acceptedHttp = 0;
let acceptedSqs = 0;
let failed = 0;
let maxLockWaiters = 0;
let lockWaitSamples = 0;
let maxOutboxPending = 0;
let monitorError: unknown;
let sampling = true;
let monitor: Promise<void> = Promise.resolve();
let measuredSeconds = 0;
let drainMs = 0;
let invariant = false;
let outcome: unknown;

async function sample(): Promise<void> {
  const [locks] = await env.orm.em.fork().execute<{ waiting: number }[]>(
    "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
  maxLockWaiters = Math.max(maxLockWaiters, locks?.waiting ?? 0);
  lockWaitSamples += locks?.waiting ?? 0;
  const [outbox] = await env.orm.em.fork().execute<{ pending: number; lag: number }[]>(`
    select count(*)::int as pending, coalesce(extract(epoch from (clock_timestamp() - min(occurred_at))) * 1000, 0)::float as lag
    from outbox_messages where published_at is null`);
  lagMs.push(outbox?.lag ?? 0);
  maxOutboxPending = Math.max(maxOutboxPending, outbox?.pending ?? 0);
  const completed = await env.orm.em.fork().execute<{ idempotency_key: string }[]>(
    "select idempotency_key from wager_transactions where provider_id = 'phase5' and status in ('PROCESSED', 'REJECTED')");
  const observed = performance.now();
  for (const row of completed) {
    const start = pending.get(row.idempotency_key);
    if (start !== undefined) { sqsCompletionMs.push(observed - start); pending.delete(row.idempotency_key); }
  }
}

try {
  const wallets = await Promise.all(Array.from({ length: walletCount }, () => env.wallet('1000000.00')));
  consumer.start();
  publishers.forEach(publisher => publisher.start());
  const started = performance.now();
  const deadline = started + duration * 1000;
  monitor = (async () => {
    while (sampling) { await sample(); await Bun.sleep(100); }
  })().catch((error: unknown) => { monitorError = error; });
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline && attempted < maxRequests) {
      const sequence = attempted++;
      // 50% hot wallet; remaining requests spread over the other wallets. Half HTTP, half SQS.
      const wallet = wallets[sequence % 4 < 2 || walletCount === 1 ? 0 : 1 + Math.floor(sequence / 4) % (walletCount - 1)]!;
      const command = env.command(wallet, { money: { amount: '0.01', currency: 'BRL' } });
      const start = performance.now();
      try {
        if (sequence % 2 === 0) {
          const response = await fetch(new URL('/wagers', server.url), { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(30_000) });
          const result = await response.json() as WagerResponse;
          if (!response.ok || result.status !== 'PROCESSED' || result.idempotentReplay) throw new Error(`HTTP failure: ${JSON.stringify(result)}`);
          httpMs.push(performance.now() - start);
          acceptedHttp++;
        } else {
          pending.set(command.idempotencyKey, start);
          await env.send(command);
          sqsSendMs.push(performance.now() - start);
          acceptedSqs++;
        }
      } catch (error) {
        failed++;
        if (failures.length < 10) failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  }));
  measuredSeconds = (performance.now() - started) / 1000;
  const drainStarted = performance.now();
  for (;;) {
    const [row] = await env.orm.em.fork().execute<{ terminal: number; unpublished: number }[]>(`
      select (select count(*)::int from wager_transactions where provider_id = 'phase5' and status = 'PROCESSED') as terminal,
      (select count(*)::int from outbox_messages where published_at is null) as unpublished`);
    if (row?.terminal === acceptedHttp + acceptedSqs && row.unpublished === 0) break;
    if (performance.now() - drainStarted > drainSeconds * 1000) throw new Error('Drain deadline exceeded or unexpected financial result');
    await Bun.sleep(100);
  }
  drainMs = performance.now() - drainStarted;
  sampling = false;
  await monitor;
  await sample();
  if (monitorError) throw monitorError;
  await assertLedgerInvariant(env.orm);
  const anomalies = await env.orm.em.fork().execute<{ id: string }[]>(`
    select w.id from wallets w where w.balance <> 1000000.00 - 0.01 *
      (select count(*) from wager_transactions t where t.wallet_id = w.id and t.kind = 'BET' and t.status = 'PROCESSED')`);
  if (anomalies.length || pending.size || failed) throw new Error(`Load validation failed: ${anomalies.length} wallets, ${pending.size} pending, ${failed} errors`);
  invariant = true;
} catch (error) { outcome = error; }
finally {
  sampling = false;
  await monitor;
  await consumer.stop();
  await Promise.all(publishers.map(publisher => publisher.stop()));
  await server.stop(true);
  const [db] = await env.orm.em.fork().execute<{ version: string; deadlocks: number }[]>(
    'select version() as version, deadlocks::int from pg_stat_database where datname = current_database()');
  const report = {
    generatedAt: new Date().toISOString(), passed: invariant && outcome === undefined,
    environment: { bun: Bun.version, os: platform(), arch: arch(), cpus: cpus().length, memoryBytes: totalmem(),
      postgres: db?.version, sqs: 'LocalStack 4.10.0 (Docker Compose default)', http: 'Bun benchmark adapter -> real Nest WageringModule' },
    methodology: { durationSeconds: duration, concurrency, walletCount, maxRequests, hotWalletShare: 0.5,
      httpShare: 0.5, publishers: 4, consumerConcurrency: Math.min(concurrency, 32), sampleIntervalMs: 100,
      latencyUnit: 'ms', sqsCompletion: 'observed database commit, includes polling delay',
      lockWaitSamples: 'sum of waiting sessions per sample; not unique conflicts', warmup: 'none; cold run' },
    attempted, acceptedHttp, acceptedSqs, failed, errorRate: attempted ? failed / attempted : 0,
    measuredSeconds, drainMs,
    throughput: { acceptedPerSecond: (acceptedHttp + acceptedSqs) / measuredSeconds,
      completedPerSecondIncludingDrain: (acceptedHttp + acceptedSqs) / (measuredSeconds + drainMs / 1000) },
    latency: { http: distribution(httpMs), sqsSend: distribution(sqsSendMs), sqsObservedCommit: distribution(sqsCompletionMs) },
    locks: { maxWaiters: maxLockWaiters, waitingSessionSamples: lockWaitSamples, databaseDeadlocks: db?.deadlocks },
    outbox: { maxPending: maxOutboxPending, oldestPendingAgeMs: distribution(lagMs), maxLagMs: Math.max(0, ...lagMs) },
    invariant, failures, failure: outcome instanceof Error ? outcome.message : outcome === undefined ? null : String(outcome),
  };
  await mkdir('reports', { recursive: true });
  const path = `reports/load-${Date.now()}.json`;
  await Bun.write(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${path}`);
  await app.close();
  await env.close();
}
if (outcome) throw outcome;
