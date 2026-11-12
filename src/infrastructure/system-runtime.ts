import { createHash, randomUUID } from 'node:crypto';

import type { ApplicationRuntime } from '../application/wagering/contracts';

export class SystemRuntime implements ApplicationRuntime {
  id(): string {
    return randomUUID();
  }
  now(): Date {
    return new Date();
  }
  sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
  async pause(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  random(): number {
    return Math.random();
  }
}
