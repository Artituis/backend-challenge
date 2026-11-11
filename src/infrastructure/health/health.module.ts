import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { PersistenceModule } from '../persistence/persistence.module';
import { SqsMessaging } from '../messaging/sqs';
import { messagingConfig } from '../messaging/config';

export class HealthService {
  private pending: Promise<{ status: string; dependencies: { postgres: string; sqs: string } }> | undefined;
  private databaseProbe: Promise<unknown> | undefined;
  constructor(private readonly database: () => Promise<unknown>, private readonly queue: (signal: AbortSignal) => Promise<unknown>,
    private readonly timeoutMs = 2500) {}
  live(): { status: string } { return { status: 'ok' }; }
  ready() {
    // Share concurrent probes; never cache a completed success.
    return this.pending ??= this.check().finally(() => { this.pending = undefined; });
  }
  private async check() {
    const controller = new AbortController();
    const bounded = async (work: () => Promise<unknown>): Promise<string> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Probe timeout')); }, this.timeoutMs);
        })]);
        return 'up';
      } catch { return 'down'; } finally { clearTimeout(timer); }
    };
    const [postgres, sqs] = await Promise.all([bounded(() => {
      // A saturated pool must not accumulate one abandoned acquisition per health request.
      return this.databaseProbe ??= Promise.resolve().then(this.database).finally(() => { this.databaseProbe = undefined; });
    }), bounded(() => this.queue(controller.signal))]);
    controller.abort();
    return { status: postgres === 'up' && sqs === 'up' ? 'ok' : 'unavailable', dependencies: { postgres, sqs } };
  }
}

class HealthQueue extends SqsMessaging { onApplicationShutdown(): void { this.close(); } }
export class HealthModule {}
Module({
  imports: [PersistenceModule],
  providers: [
    { provide: HealthQueue, useFactory: () => new HealthQueue(messagingConfig()) },
    { provide: HealthService, inject: [MikroORM, HealthQueue], useFactory: (orm: MikroORM, sqs: HealthQueue) =>
      new HealthService(() => orm.em.getConnection().getKnex().raw('select 1').timeout(2000, { cancel: true }),
        signal => sqs.probe(signal)) },
  ],
  exports: [HealthService],
})(HealthModule);
