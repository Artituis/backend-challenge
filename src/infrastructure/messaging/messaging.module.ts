import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK } from '../../application/ports/persistence';
import type { UnitOfWork } from '../../application/ports/persistence';
import { ProcessWager } from '../../application/wagering/process-wager';
import { WageringModule } from '../wagering.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { SystemRuntime } from '../system-runtime';
import { messagingConfig } from './config';
import type { MessagingConfig } from './config';
import { ConsumerWorker } from './consumer-worker';
import { MikroDispositionStore } from './dispositions';
import { SqsMessaging } from './sqs';
import { OutboxWorker } from './outbox-worker';
import { PendingReferenceWorker } from './pending-reference-worker';
import { WorkerLoop } from './loop';

const CONFIG = Symbol('MESSAGING_CONFIG');
class WorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly loops: WorkerLoop[];
  constructor(private readonly sqs: SqsMessaging, private readonly consumer: ConsumerWorker,
    outbox: OutboxWorker, pending: PendingReferenceWorker, config: MessagingConfig) {
    this.loops = [
      ...Array.from({ length: config.publisherConcurrency }, () => new WorkerLoop('Outbox', () => outbox.runOnce(), config.idleMs)),
      new WorkerLoop('PendingReference', () => pending.runOnce(), config.idleMs),
    ];
  }
  async onApplicationBootstrap(): Promise<void> {
    await this.sqs.initialize();
    this.consumer.start();
    this.loops.forEach(loop => loop.start());
  }
  async beforeApplicationShutdown(): Promise<void> {
    // Drain before PersistenceShutdown closes the database pool in the next lifecycle phase.
    await Promise.all([this.consumer.stop(), ...this.loops.map(loop => loop.stop())]);
  }
  onApplicationShutdown(): void { this.sqs.close(); }
}

export class MessagingModule {}
Module({
  imports: [WageringModule, PersistenceModule],
  providers: [
    { provide: CONFIG, useFactory: messagingConfig },
    { provide: SqsMessaging, inject: [CONFIG], useFactory: (config: MessagingConfig) => new SqsMessaging(config) },
    { provide: MikroDispositionStore, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroDispositionStore(orm) },
    { provide: ConsumerWorker, inject: [SqsMessaging, MikroDispositionStore, ProcessWager, CONFIG],
      useFactory: (sqs: SqsMessaging, store: MikroDispositionStore, processor: ProcessWager, config: MessagingConfig) => new ConsumerWorker(sqs, store, processor, config) },
    { provide: OutboxWorker, inject: [UNIT_OF_WORK, SqsMessaging],
      useFactory: (uow: UnitOfWork, sqs: SqsMessaging) => new OutboxWorker(uow, sqs, new SystemRuntime()) },
    { provide: PendingReferenceWorker, inject: [ProcessWager, CONFIG],
      useFactory: (processor: ProcessWager, config: MessagingConfig) => new PendingReferenceWorker(processor, config) },
    { provide: WorkerLifecycle, inject: [SqsMessaging, ConsumerWorker, OutboxWorker, PendingReferenceWorker, CONFIG],
      useFactory: (sqs: SqsMessaging, consumer: ConsumerWorker, outbox: OutboxWorker, pending: PendingReferenceWorker, config: MessagingConfig) =>
        new WorkerLifecycle(sqs, consumer, outbox, pending, config) },
  ],
  exports: [SqsMessaging],
})(MessagingModule);
