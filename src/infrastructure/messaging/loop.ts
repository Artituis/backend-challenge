import { Logger } from '@nestjs/common';
import { setTimeout as pause } from 'node:timers/promises';

/** Interruptible idle waits; errors never leave an unobserved rejected loop promise. */
export class WorkerLoop {
  private readonly stopSignal = new AbortController();
  private task: Promise<void> | undefined;
  private readonly logger: Logger;
  constructor(name: string, private readonly work: (signal: AbortSignal) => Promise<boolean>, private readonly idleMs: number) {
    this.logger = new Logger(name);
  }
  start(): void { this.task ??= this.run(); }
  stop(): Promise<void> { this.stopSignal.abort(); return this.task ?? Promise.resolve(); }
  private async run(): Promise<void> {
    while (!this.stopSignal.signal.aborted) {
      let busy = false;
      try { busy = await this.work(this.stopSignal.signal); }
      catch (error) { if (!this.stopSignal.signal.aborted) this.logger.error(error instanceof Error ? error.message : 'Worker failed'); }
      if (!busy && !this.stopSignal.signal.aborted) {
        await pause(this.idleMs, undefined, { signal: this.stopSignal.signal }).catch(() => undefined);
      }
    }
  }
}
