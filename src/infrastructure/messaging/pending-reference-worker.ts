import type { ProcessWager } from '../../application/wagering/process-wager';
import type { MessagingConfig } from './config';
import { withTrace } from '../observability/telemetry';

export class PendingReferenceWorker {
  constructor(private readonly processor: ProcessWager, private readonly config: MessagingConfig) {}
  runOnce(): Promise<boolean> {
    return withTrace({}, () => this.processor.reprocessNextPending({ ttlMs: this.config.pendingTtlMs,
      baseDelayMs: this.config.pendingBaseDelayMs, maxDelayMs: this.config.pendingMaxDelayMs }));
  }
}
