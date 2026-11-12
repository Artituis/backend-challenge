// A real worker process paused at an observable failure boundary. No fake DB or broker.
import { MikroORM } from '@mikro-orm/postgresql';

import { ProcessWager } from '../../src/application/wagering/process-wager';
import type { OutboxMessage } from '../../src/domain';
import { messagingConfig } from '../../src/infrastructure/messaging/config';
import { ConsumerWorker } from '../../src/infrastructure/messaging/consumer-worker';
import { MikroDispositionStore } from '../../src/infrastructure/messaging/dispositions';
import { OutboxWorker } from '../../src/infrastructure/messaging/outbox-worker';
import type { Delivery } from '../../src/infrastructure/messaging/sqs';
import { SqsMessaging } from '../../src/infrastructure/messaging/sqs';
import { MikroUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { SystemRuntime } from '../../src/infrastructure/system-runtime';
import { isolatedConfig } from '../support/environment';

async function barrier(): Promise<void> {
  console.log('FAILURE_BOUNDARY_REACHED');
  await new Promise<void>(() => {
    setInterval(() => undefined, 1000);
  });
}
class PausingSqs extends SqsMessaging {
  override async ack(queue: string, message: Delivery): Promise<void> {
    if (process.env['CRASH_POINT'] === 'before-ack') await barrier();
    await super.ack(queue, message);
  }
  override async publish(message: OutboxMessage): Promise<void> {
    await super.publish(message);
    if (process.env['CRASH_POINT'] === 'after-publish') await barrier();
  }
}
const config = { ...messagingConfig(), visibilitySeconds: 3, requestTimeoutMs: 500 };
const orm = await MikroORM.init(
  isolatedConfig(process.env['DATABASE_URL']!, process.env['TEST_SCHEMA']!),
);
const uow = new MikroUnitOfWork(orm);
const runtime = new SystemRuntime();
const sqs = new PausingSqs(config);
await sqs.initialize();
if (process.env['CRASH_POINT'] === 'after-publish') {
  await new OutboxWorker(uow, sqs, runtime).runOnce();
} else {
  const message = await sqs.receive(config.queueName, AbortSignal.timeout(5000));
  if (!message) throw new Error('Expected queued command');
  await new ConsumerWorker(
    sqs,
    new MikroDispositionStore(orm),
    new ProcessWager(uow, runtime),
    config,
  ).handle(config.queueName, message);
}
await orm.close(true);
sqs.close();
