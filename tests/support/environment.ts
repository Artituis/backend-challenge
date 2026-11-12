import { DeleteQueueCommand, GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import type { WagerCommand } from '../../src/application/wagering/contracts';
import { ProcessWager } from '../../src/application/wagering/process-wager';
import { Money, WagerTransaction, WagerTransactionKind, Wallet } from '../../src/domain';
import { messagingConfig } from '../../src/infrastructure/messaging/config';
import { provisionQueues } from '../../src/infrastructure/messaging/provision';
import { SqsMessaging } from '../../src/infrastructure/messaging/sqs';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { SystemRuntime } from '../../src/infrastructure/system-runtime';
import { assertLedgerInvariant } from './invariant';

export const id = (): string => crypto.randomUUID();

export function isolatedConfig(database: string, schema: string) {
  if (!/^phase5_[a-f0-9]+$/.test(schema)) throw new Error('Invalid test schema');
  return {
    ...persistenceConfig(database),
    schema,
    driverOptions: { connection: { options: `-c search_path=${schema}` } },
  };
}

export async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Condition not satisfied within ${timeoutMs}ms`);
    await Bun.sleep(25);
  }
}

export class TestEnvironment {
  readonly schema = `phase5_${id().replaceAll('-', '')}`;
  readonly runtime = new SystemRuntime();
  readonly config = {
    ...messagingConfig({}),
    endpoint: process.env['TEST_SQS_ENDPOINT']!,
    queueName: `${this.schema}.fifo`,
    dlqName: `${this.schema}-dlq.fifo`,
    eventsQueueName: `${this.schema}-events.fifo`,
    // Network allowance must tolerate Docker scheduling after a one-second empty long poll.
    pollSeconds: 1,
    idleMs: 10,
    visibilitySeconds: 3,
    requestTimeoutMs: 2000,
  };
  readonly sqs = new SqsMessaging(this.config);
  admin!: MikroORM;
  orm!: MikroORM;
  uow!: MikroUnitOfWork;
  processor!: ProcessWager;
  database!: string;

  async start(): Promise<void> {
    const database = process.env['TEST_DATABASE_URL'];
    if (!database || !new URL(database).pathname.endsWith('_test') || !this.config.endpoint) {
      throw new Error('Requires TEST_DATABASE_URL ending in _test and TEST_SQS_ENDPOINT');
    }
    this.admin = await MikroORM.init(persistenceConfig(database));
    await this.admin.em.getConnection().execute(`create schema ${this.schema}`);
    const connection = new URL(database);
    connection.searchParams.set('options', `-c search_path=${this.schema}`);
    this.database = connection.toString();
    this.orm = await MikroORM.init(isolatedConfig(this.database, this.schema));
    await this.orm.getMigrator().up();
    this.uow = new MikroUnitOfWork(this.orm);
    this.processor = new ProcessWager(this.uow, this.runtime);
    await provisionQueues(this.sqs.client, this.config);
    await this.sqs.initialize();
  }

  childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      DATABASE_URL: this.database,
      TEST_SCHEMA: this.schema,
      PGOPTIONS: `-c search_path=${this.schema}`,
      WORKER_HEALTH_PORT: '0',
      SQS_ENDPOINT: this.config.endpoint,
      SQS_QUEUE_NAME: this.config.queueName,
      SQS_DLQ_NAME: this.config.dlqName,
      SQS_EVENTS_QUEUE_NAME: this.config.eventsQueueName,
      SQS_POLL_SECONDS: '1',
      WORKER_IDLE_MS: '10',
    };
  }

  async close(): Promise<void> {
    try {
      if (this.orm) await assertLedgerInvariant(this.orm);
    } finally {
      try {
        for (const name of [
          this.config.queueName,
          this.config.dlqName,
          this.config.eventsQueueName,
        ]) {
          const { QueueUrl } = await this.sqs.client.send(
            new GetQueueUrlCommand({ QueueName: name }),
          );
          await this.sqs.client.send(new DeleteQueueCommand({ QueueUrl: QueueUrl! }));
        }
      } finally {
        this.sqs.close();
        if (this.orm) await this.orm.close(true);
        if (this.admin) {
          await this.admin.em
            .getConnection()
            .execute(`drop schema if exists ${this.schema} cascade`);
          await this.admin.close(true);
        }
      }
    }
  }

  async wallet(amount = '100.00'): Promise<Wallet> {
    const at = this.runtime.now();
    const openingId = id();
    const wallet = Wallet.open({
      id: id(),
      playerId: id(),
      initialBalance: Money.from({ amount, currency: 'BRL' }),
      at,
      opening: { transactionId: openingId, ledgerEntryId: id() },
    });
    await this.uow.run(async (r) => {
      if (wallet.balance.isPositive()) {
        const opening = WagerTransaction.createOpening({
          id: openingId,
          providerId: 'internal',
          externalTransactionId: openingId,
          idempotencyKey: openingId,
          payloadHash: 'opening',
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'opening',
          gameId: 'internal',
          money: wallet.balance,
          createdAt: at,
        });
        opening.markProcessed(undefined, at);
        r.transactions.add(opening);
      }
      r.wallets.add(wallet);
    });
    return wallet;
  }

  command(wallet: Wallet, overrides: Partial<WagerCommand> = {}): WagerCommand {
    const key = id();
    return {
      providerId: 'phase5',
      walletId: wallet.id,
      playerId: wallet.playerId,
      externalTransactionId: key,
      idempotencyKey: key,
      roundId: 'round',
      gameId: 'game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
    };
  }

  async send(command: WagerCommand): Promise<string> {
    const { QueueUrl } = await this.sqs.client.send(
      new GetQueueUrlCommand({ QueueName: this.config.queueName }),
    );
    const result = await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: JSON.stringify(command),
        MessageGroupId: command.walletId,
        MessageDeduplicationId: id(),
      }),
    );
    if (!result.MessageId) throw new Error('SQS returned no message ID');
    return result.MessageId;
  }

  async receive(queue = this.config.queueName) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const message = await this.sqs.receive(queue, AbortSignal.timeout(5000));
      if (message) return message;
    }
    throw new Error(`No delivery from ${queue}`);
  }
}
