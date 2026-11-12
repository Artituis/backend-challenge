import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { LoggerService } from '@nestjs/common';
import type { DestinationStream, Level } from 'pino';
import pino from 'pino';

import type { WagerObserver } from '../../application/ports/telemetry';
import type { WagerResponse } from '../../application/wagering/contracts';

const ids = ['correlationId', 'messageId', 'transactionId', 'walletId', 'providerId'] as const;
export type TraceContext = Partial<Record<(typeof ids)[number], string>>;
const storage = new AsyncLocalStorage<TraceContext>();
// Reject arbitrary text/JSON in identifiers. No request, response, error or SQL serializers.
export const safeId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,128}$/.test(value) ? value : undefined;
export function trace(): TraceContext {
  return storage.getStore() ?? {};
}
export function bindTrace(context: TraceContext): void {
  const current = storage.getStore();
  if (current)
    for (const key of ids) {
      const value = safeId(context[key]);
      if (value !== undefined) current[key] = value;
    }
}
export function withTrace<T>(context: TraceContext, work: () => T): T {
  const clean: TraceContext = {};
  for (const key of ids) {
    const value = safeId(context[key]);
    if (value !== undefined) clean[key] = value;
  }
  clean.correlationId ??= randomUUID();
  return storage.run(clean, work);
}

type Event =
  | 'http_completed'
  | 'sqs_completed'
  | 'sqs_retry'
  | 'sqs_dlq_sent'
  | 'sqs_quarantined'
  | 'visibility_failed'
  | 'outbox_published'
  | 'outbox_retry'
  | 'worker_failed'
  | 'transaction_committed'
  | 'transaction_replayed'
  | 'concurrency_retry'
  | 'lock_conflict'
  | 'reconciliation_mismatch'
  | 'Workers started'
  | 'http_started'
  | 'startup_failed'
  | 'framework_log';
type Fields = {
  status?: string;
  code?: string;
  durationMs?: number;
  attempt?: number;
  route?: string;
};
/** One projection for application, Nest and pino-http logs. Never serialize arbitrary messages. */
export function createPino(destination?: DestinationStream): pino.Logger {
  const options: pino.LoggerOptions = {
    base: null,
    formatters: { level: (label) => ({ level: label }) },
    serializers: { req: () => undefined, res: () => undefined, err: () => undefined },
    redact: {
      paths: [
        'password',
        'authorization',
        'cookie',
        'body',
        'payload',
        'money',
        'balance',
        'req.headers',
        'req.body',
        'res.body',
      ],
      censor: '[REDACTED]',
    },
    mixin: () => Object.fromEntries(ids.map((key) => [key, safeId(trace()[key]) ?? null])),
    hooks: {
      logMethod(args, method) {
        const input: unknown = args[0];
        const fields =
          typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
        const record: Record<string, unknown> = {
          event:
            fields['event'] === 'Workers started'
              ? 'Workers started'
              : (safeId(fields['event']) ?? 'framework_log'),
        };
        for (const key of ['status', 'code', 'route'] as const) {
          const value = safeId(fields[key]);
          if (value !== undefined) record[key] = value;
        }
        for (const key of ['durationMs', 'attempt'] as const) {
          if (typeof fields[key] === 'number' && Number.isFinite(fields[key]))
            record[key] = fields[key];
        }
        try {
          method.call(this, record);
        } catch {
          /* Logging must not abort a financial commit. */
        }
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
export const pinoLogger = createPino();
export class JsonLogger implements LoggerService {
  private readonly sink: pino.Logger;
  constructor(write?: (line: string) => void) {
    this.sink = write ? createPino({ write: (line) => write(line.trimEnd()) }) : pinoLogger;
  }
  event(event: Event, fields: Fields = {}, level: Level = 'info'): void {
    this.sink[level]({ ...fields, event });
  }
  // Nest may pass error objects, stack traces, connection strings or arbitrary messages.
  log(..._args: unknown[]): void {
    this.event('framework_log');
  }
  error(..._args: unknown[]): void {
    this.event('framework_log', {}, 'error');
  }
  warn(..._args: unknown[]): void {
    this.event('framework_log', {}, 'warn');
  }
  debug(..._args: unknown[]): void {}
  verbose(..._args: unknown[]): void {}
  fatal(..._args: unknown[]): void {
    this.event('framework_log', {}, 'fatal');
  }
}

const counters = [
  'duplicates',
  'idempotency_retries',
  'concurrency_retries',
  'lock_conflicts',
  'sqs_retries',
  'dlq_sent',
  'dlq_received',
  'outbox_retries',
  'reconciliation_mismatches',
] as const;
const histograms = ['http_processing', 'sqs_processing', 'outbox_lag'] as const;
const statuses = ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'] as const;
const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];
/** Fixed series and bounded memory; IDs and user input are never metric labels. */
export class Metrics {
  private readonly counts = new Map<string, number>();
  private readonly distributions = new Map<
    string,
    { buckets: number[]; count: number; sum: number }
  >();
  increment(name: (typeof counters)[number]): void {
    this.add(`wagering_${name}_total`);
  }
  transaction(status: string): void {
    if (statuses.includes(status as (typeof statuses)[number]))
      this.add(`wagering_transactions_total{status="${status}"}`);
  }
  private add(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  observe(name: (typeof histograms)[number], seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const value = this.distributions.get(name) ?? {
      buckets: bounds.map(() => 0),
      count: 0,
      sum: 0,
    };
    value.count++;
    value.sum += seconds;
    bounds.forEach((bound, i) => {
      if (seconds <= bound) value.buckets[i]!++;
    });
    this.distributions.set(name, value);
  }
  render(): string {
    const lines: string[] = [];
    for (const name of counters) {
      const key = `wagering_${name}_total`;
      lines.push(`# TYPE ${key} counter`, `${key} ${this.counts.get(key) ?? 0}`);
    }
    lines.push('# TYPE wagering_transactions_total counter');
    for (const status of statuses) {
      const key = `wagering_transactions_total{status="${status}"}`;
      lines.push(`${key} ${this.counts.get(key) ?? 0}`);
    }
    for (const name of histograms) {
      const key = `wagering_${name}_seconds`;
      const value = this.distributions.get(name);
      lines.push(`# TYPE ${key} histogram`);
      bounds.forEach((bound, i) =>
        lines.push(`${key}_bucket{le="${bound}"} ${value?.buckets[i] ?? 0}`),
      );
      lines.push(
        `${key}_bucket{le="+Inf"} ${value?.count ?? 0}`,
        `${key}_count ${value?.count ?? 0}`,
        `${key}_sum ${value?.sum ?? 0}`,
      );
    }
    return lines.join('\n') + '\n';
  }
}
export const logger = new JsonLogger();
export const metrics = new Metrics();
export const wagerObserver: WagerObserver = {
  committed(result: WagerResponse, context): void {
    bindTrace({ ...context, transactionId: result.transactionId });
    if (result.idempotentReplay) metrics.increment('duplicates');
    else metrics.transaction(result.status);
    logger.event(result.idempotentReplay ? 'transaction_replayed' : 'transaction_committed', {
      status: result.status,
    });
  },
  retry(): void {
    metrics.increment('concurrency_retries');
    logger.event('concurrency_retry', {}, 'warn');
  },
};
