import { logger, metrics, safeId, withTrace } from '../observability/telemetry';
import type { UnitOfWork } from '../../application/ports/persistence';
import type { ApplicationRuntime } from '../../application/wagering/contracts';
import type { QueueTransport } from './sqs';

export class OutboxWorker {
  constructor(private readonly uow: UnitOfWork, private readonly transport: QueueTransport,
    private readonly runtime: ApplicationRuntime) {}
  async runOnce(): Promise<boolean> {
    return this.uow.run(async r => {
      const [message] = await r.outbox.findDue(this.runtime.now(), 1);
      if (!message) return false;
      const transactionId = safeId(message.payload['transactionId']);
      const providerId = safeId(message.payload['providerId']);
      return withTrace({ correlationId: safeId(message.payload['correlationId']) ?? message.id,
        messageId: safeId(message.payload['messageId']) ?? message.id,
        ...(transactionId ? { transactionId } : {}), ...(providerId ? { providerId } : {}),
        walletId: message.aggregateId }, async () => {
        // Keep the SKIP LOCKED claim until publication + status commit. The SQS call is bounded.
        try { await this.transport.publish(message); }
        catch {
          message.scheduleRetry(new Date(Math.max(this.runtime.now().getTime(), message.occurredAt.getTime(), message.nextAttemptAt?.getTime() ?? 0)));
          r.outbox.save(message);
          metrics.increment('outbox_retries');
          logger.event('outbox_retry', { attempt: message.attempts }, 'warn');
          return true;
        }
        message.markPublished(new Date(Math.max(this.runtime.now().getTime(), message.occurredAt.getTime())));
        metrics.observe('outbox_lag', Math.max(0, message.publishedAt!.getTime() - message.occurredAt.getTime()) / 1000);
        logger.event('outbox_published');
        r.outbox.save(message);
        return true;
      });
    });
  }
}
