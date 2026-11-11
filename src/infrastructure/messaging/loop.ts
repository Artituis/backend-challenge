import { logger } from '../observability/telemetry';
import { setTimeout as pause } from 'node:timers/promises';

/** Interruptible idle waits; errors never leave an unobserved rejected loop promise. */
export class WorkerLoop {
  private readonly stopSignal = new AbortController();
  private task: Promise<void> | undefined;
  constructor(_name: string, private readonly work: (signal: AbortSignal) => Promise<boolean>, private readonly idleMs: number) {}
  start(): void { this.task ??= this.run(); }
  stop(): Promise<void> { this.stopSignal.abort(); return this.task ?? Promise.resolve(); }
  private async run(): Promise<void> {
    while (!this.stopSignal.signal.aborted) {
      let busy = false;
      try { busy = await this.work(this.stopSignal.signal); }
      catch { if (!this.stopSignal.signal.aborted) logger.event('worker_failed', {}, 'error'); }
      if (!busy && !this.stopSignal.signal.aborted) {
        await pause(this.idleMs, undefined, { signal: this.stopSignal.signal }).catch(() => undefined);
      }
    }
  }
}
