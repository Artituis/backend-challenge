import { bindTrace, logger, metrics, withTrace } from '../observability/telemetry';
import type { ProcessWager } from '../../application/wagering/process-wager';
import type { MessagingConfig } from './config';
import type { DispositionStore } from './dispositions';
import type { Delivery, QueueTransport } from './sqs';
import { classify, decodeWager, reason } from './decode';
import { WorkerLoop } from './loop';

interface InFlight {
  queue: string;
  message: Delivery;
  abandoned: boolean;
  stopHeartbeat(): Promise<void>;
}

export class ConsumerWorker {
  private readonly active = new Set<InFlight>();
  private readonly loops: WorkerLoop[] = [];
  private stopping = false;
  constructor(private readonly transport: QueueTransport, private readonly dispositions: DispositionStore,
    private readonly processor: Pick<ProcessWager, 'execute'>, private readonly config: MessagingConfig) {}

  start(): void {
    if (this.loops.length || this.stopping) return;
    for (const queue of [
      ...Array.from({ length: this.config.consumerConcurrency }, () => this.config.queueName), this.config.dlqName,
    ]) {
      const loop = new WorkerLoop(`Consumer:${queue}`, async signal => {
        const message = await this.transport.receive(queue, signal);
        if (!message) return false;
        if (this.stopping) { await this.transport.visibility(queue, message, 0); return false; }
        await this.handle(queue, message);
        return true;
      }, this.config.idleMs);
      this.loops.push(loop);
      loop.start();
    }
  }

  async handle(queue: string, message: Delivery): Promise<void> {
    return withTrace({ correlationId: message.id, messageId: message.id }, async () => {
      const started = performance.now();
      try { await this.handleDelivery(queue, message); }
      finally {
        const durationMs = performance.now() - started;
        metrics.observe('sqs_processing', durationMs / 1000);
        logger.event('sqs_completed', { durationMs });
      }
    });
  }

  private async sendToDlq(message: Delivery, reason: string): Promise<void> {
    await this.transport.deadLetter(message, reason);
    metrics.increment('dlq_sent');
    logger.event('sqs_dlq_sent', {}, 'warn');
  }

  private async handleDelivery(queue: string, message: Delivery): Promise<void> {
    try {
      const command = decodeWager(message.body, this.config.consumerName, message.id);
      bindTrace({ correlationId: command.correlationId!, walletId: command.walletId, providerId: command.providerId });
    } catch { /* Malformed deliveries retain only trusted transport identifiers. */ }
    let renewing: Promise<void> = Promise.resolve();
    let heartbeatStopped = false;
    const timer = setInterval(() => {
      if (heartbeatStopped) return;
      // Serialize renewals, including completion of an in-flight renewal before retry/release.
      renewing = renewing.then(async () => {
        if (!heartbeatStopped) await this.transport.visibility(queue, message, this.config.visibilitySeconds);
      }).catch(() => { logger.event('visibility_failed', {}, 'warn'); });
    }, this.config.visibilitySeconds * 1000 / 3);
    const flight: InFlight = { queue, message, abandoned: false, stopHeartbeat: async () => {
      heartbeatStopped = true; clearInterval(timer); await renewing;
    } };
    this.active.add(flight);
    try {
      if (queue === this.config.dlqName) {
        await this.dispositions.save(queue, message, 'QUARANTINED', 'DLQ_RECEIVED');
        metrics.increment('dlq_received');
        logger.event('sqs_quarantined', {}, 'warn');
      } else {
        const saved = await this.dispositions.find(queue, message);
        if (flight.abandoned) return;
        if (saved) {
          metrics.increment('duplicates');
          if (saved.disposition === 'DEAD_LETTER' && !flight.abandoned) await this.sendToDlq(message, saved.reason);
        } else {
          try {
            const command = decodeWager(message.body, this.config.consumerName, message.id);
            bindTrace({ correlationId: command.correlationId!, walletId: command.walletId, providerId: command.providerId });
            const result = await this.processor.execute(command);
            bindTrace({ transactionId: result.transactionId });
          } catch (error) {
            const failure = classify(error);
            if (failure === 'transient' && message.receives < this.config.maxReceives) throw error;
            const outcome = failure === 'terminal' ? 'TERMINAL' : 'DEAD_LETTER';
            const failureReason = reason(error);
            // A failed/invalid command has no financial commit; commit its durable disposition instead.
            await this.dispositions.save(queue, message, outcome, failureReason);
            if (outcome === 'DEAD_LETTER' && !flight.abandoned) await this.sendToDlq(message, failureReason);
          }
        }
      }
      await flight.stopHeartbeat();
      // execute/save have resolved only after COMMIT; failed DLQ publication never reaches ack.
      if (!flight.abandoned) await this.transport.ack(queue, message);
    } catch (error) {
      await flight.stopHeartbeat();
      metrics.increment('sqs_retries');
      logger.event('sqs_retry', { attempt: message.receives }, 'warn');
      if (!flight.abandoned) {
        const seconds = Math.min(900, 2 ** Math.min(Math.max(0, message.receives - 1), 10) + Math.floor(Math.random() * 3));
        // If this fails, the existing visibility timeout still makes the delivery recoverable.
        await this.transport.visibility(queue, message, seconds).catch(() => undefined);
      }
    } finally {
      await flight.stopHeartbeat();
      this.active.delete(flight);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const drained = Promise.all(this.loops.map(loop => loop.stop())).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const complete = await Promise.race([drained,
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.config.shutdownMs); })]);
    clearTimeout(timer);
    if (complete) return;
    await Promise.all([...this.active].map(async flight => {
      flight.abandoned = true;
      await flight.stopHeartbeat();
      await this.transport.visibility(flight.queue, flight.message, 0).catch(() => undefined);
    }));
    // In-flight DB work may finish, but it can no longer ack or send to DLQ.
    // Inbox and wallet locks protect another replica receiving the released delivery.
  }
}
