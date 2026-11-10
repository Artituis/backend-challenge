import { FailureCode, invariant } from './errors';
import { counter, date, dateAfter, identifier } from './validation';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** Copy and deeply freeze JSON; reject lossy serialization, cycles and class instances. */
function immutableJson(value: JsonValue, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), FailureCode.InvalidPayload, 'JSON numbers must be finite');
    return value;
  }
  invariant(typeof value === 'object', FailureCode.InvalidPayload, 'Payload must contain only JSON values');
  invariant(!ancestors.has(value), FailureCode.InvalidPayload, 'Cyclic payload');
  invariant(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    FailureCode.InvalidPayload, 'Payload must use plain JSON objects');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? Object.freeze(Array.from(value, item => immutableJson(item as JsonValue, ancestors)))
    : Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableJson(item as JsonValue, ancestors)])));
  ancestors.delete(value);
  return result;
}

export interface EnqueueOutboxProps {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly occurredAt: Date;
}
export interface OutboxMessageState extends EnqueueOutboxProps {
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly publishedAt?: Date;
}
export interface RetryPolicy { readonly baseDelayMs: number; readonly maxDelayMs: number; }

export class OutboxMessage {
  readonly #props: EnqueueOutboxProps;
  #attempts: number;
  #nextAttemptAt: Date | undefined;
  #publishedAt: Date | undefined;
  private constructor(state: OutboxMessageState) {
    for (const field of ['id', 'aggregateId', 'eventType'] as const) identifier(state[field], field);
    counter(state.attempts);
    invariant(state.payload !== null && typeof state.payload === 'object' && !Array.isArray(state.payload), FailureCode.InvalidPayload, 'Payload must be a JSON object');
    this.#props = Object.freeze({ id: state.id, aggregateId: state.aggregateId, eventType: state.eventType,
      payload: immutableJson(state.payload) as JsonObject, occurredAt: date(state.occurredAt) });
    this.#attempts = state.attempts;
    this.#nextAttemptAt = state.nextAttemptAt === undefined ? undefined : dateAfter(state.nextAttemptAt, state.occurredAt);
    this.#publishedAt = state.publishedAt === undefined ? undefined : dateAfter(state.publishedAt, state.occurredAt);
    invariant(this.#publishedAt === undefined || this.#nextAttemptAt === undefined, FailureCode.InvalidState, 'Published message cannot have a retry scheduled');
    invariant(this.#attempts > 0 || this.#nextAttemptAt === undefined, FailureCode.InvalidState, 'Retry requires a failed attempt');
    Object.freeze(this);
  }
  static enqueue(props: EnqueueOutboxProps): OutboxMessage {
    return new OutboxMessage({ id: props.id, aggregateId: props.aggregateId, eventType: props.eventType,
      payload: props.payload, occurredAt: props.occurredAt, attempts: 0 });
  }
  static rehydrate(state: OutboxMessageState): OutboxMessage { return new OutboxMessage(state); }
  get id(): string { return this.#props.id; }
  get aggregateId(): string { return this.#props.aggregateId; }
  get eventType(): string { return this.#props.eventType; }
  get payload(): JsonObject { return this.#props.payload; }
  get occurredAt(): Date { return date(this.#props.occurredAt); }
  get attempts(): number { return this.#attempts; }
  get nextAttemptAt(): Date | undefined { return this.#nextAttemptAt === undefined ? undefined : date(this.#nextAttemptAt); }
  get publishedAt(): Date | undefined { return this.#publishedAt === undefined ? undefined : date(this.#publishedAt); }
  isPending(): boolean { return this.#publishedAt === undefined; }
  isDue(now: Date): boolean {
    const at = date(now);
    return this.isPending() && at.getTime() >= (this.#nextAttemptAt ?? this.#props.occurredAt).getTime();
  }
  markPublished(at: Date): void {
    invariant(this.isPending(), FailureCode.InvalidState, 'Outbox message already published');
    this.#publishedAt = dateAfter(at, this.#props.occurredAt);
    this.#nextAttemptAt = undefined;
  }
  /** attempts counts failed publications; retry indefinitely with a bounded delay. */
  scheduleRetry(now: Date, policy: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 300_000 }): void {
    invariant(this.isDue(now), FailureCode.InvalidState, 'Outbox message is not due');
    counter(policy.baseDelayMs, 1);
    counter(policy.maxDelayMs, policy.baseDelayMs);
    counter(this.#attempts + 1);
    const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(this.#attempts, 53));
    const next = date(new Date(now.getTime() + delay));
    this.#attempts += 1;
    this.#nextAttemptAt = next;
  }
}
