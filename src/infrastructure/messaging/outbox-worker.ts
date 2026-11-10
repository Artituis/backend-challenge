import { Logger } from '@nestjs/common';
import type { UnitOfWork } from '../../application/ports/persistence';
import type { ApplicationRuntime } from '../../application/wagering/contracts';
import type { QueueTransport } from './sqs';

export class OutboxWorker {
  private readonly logger = new Logger(OutboxWorker.name);
  constructor(private readonly uow: UnitOfWork, private readonly transport: QueueTransport,
    private readonly runtime: ApplicationRuntime) {}
  async runOnce(): Promise<boolean> {
    return this.uow.run(async r => {
      const [message] = await r.outbox.findDue(this.runtime.now(), 1);
      if (!message) return false;
      // Keep the SKIP LOCKED claim until publication + status commit. The SQS call is bounded.
      try { await this.transport.publish(message); }
      catch {
        message.scheduleRetry(new Date(Math.max(this.runtime.now().getTime(), message.occurredAt.getTime(), message.nextAttemptAt?.getTime() ?? 0)));
        r.outbox.save(message);
        this.logger.warn(`Publication failed eventId=${message.id} attempts=${message.attempts}`);
        return true;
      }
      message.markPublished(new Date(Math.max(this.runtime.now().getTime(), message.occurredAt.getTime())));
      r.outbox.save(message);
      return true;
    });
  }
}
