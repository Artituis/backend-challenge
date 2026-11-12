import { describe, expect, test } from 'bun:test';

import type { JsonObject, JsonValue } from '../../src/domain';
import { DomainError, InboxMessage, OutboxMessage } from '../../src/domain';
import { at, later } from './fixtures';

const inboxProps = () => ({
  messageId: 'msg-1',
  consumerName: 'wagering',
  payloadHash: 'hash-1',
  receivedAt: at(),
});
const outboxProps = () => ({
  id: 'event-1',
  aggregateId: 'wallet-1',
  eventType: 'WalletBalanceChanged',
  payload: {
    data: { money: { amount: '10.00', currency: 'BRL' } },
    version: 1,
    tags: ['wagering'],
  },
  occurredAt: at(),
});

describe('InboxMessage', () => {
  test('receives pending and tracks processing once', () => {
    const inbox = InboxMessage.receive(inboxProps());
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();
    inbox.markProcessed(later());
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(later());
    expect(() => inbox.markProcessed(later())).toThrow(DomainError);
  });
  test('deduplication identity includes consumer and validates payload hash', () => {
    const inbox = InboxMessage.receive(inboxProps());
    inbox.assertSameDelivery(inboxProps());
    for (const field of ['messageId', 'consumerName', 'payloadHash']) {
      expect(() => inbox.assertSameDelivery({ ...inboxProps(), [field]: 'other' })).toThrow(
        DomainError,
      );
    }
  });
  test('defends dates and rejects invalid processing timestamps atomically', () => {
    const props = inboxProps();
    const inbox = InboxMessage.receive(props);
    props.receivedAt.setFullYear(2000);
    inbox.receivedAt.setFullYear(2000);
    expect(inbox.receivedAt).toEqual(at());
    expect(() => inbox.markProcessed(new Date('2025-01-01'))).toThrow(DomainError);
    expect(inbox.isProcessed()).toBe(false);
    const processedAt = later();
    inbox.markProcessed(processedAt);
    processedAt.setFullYear(2000);
    inbox.processedAt?.setFullYear(2000);
    expect(inbox.processedAt).toEqual(later());
  });
  test('rehydrates without replaying processing', () => {
    const inbox = InboxMessage.rehydrate({ ...inboxProps(), processedAt: later() });
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(later());
    expect(() => InboxMessage.receive({ ...inboxProps(), consumerName: '' })).toThrow(DomainError);
  });
});

describe('OutboxMessage', () => {
  test('starts due at occurrence time, with zero failed attempts', () => {
    const outbox = OutboxMessage.enqueue(outboxProps());
    expect(outbox.isPending()).toBe(true);
    expect(outbox.attempts).toBe(0);
    expect(outbox.isDue(at())).toBe(true);
    expect(outbox.isDue(new Date('2025-01-01'))).toBe(false);
    expect(() => outbox.isDue(new Date('invalid'))).toThrow(DomainError);
  });
  test('exponential retries are capped and checked at exact time boundaries', () => {
    const outbox = OutboxMessage.enqueue(outboxProps());
    let now = at();
    for (const [index, delay] of [1000, 2000, 4000, 4000, 4000].entries()) {
      outbox.scheduleRetry(now, { baseDelayMs: 1000, maxDelayMs: 4000 });
      expect(outbox.attempts).toBe(index + 1);
      expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + delay);
      now = new Date(now.getTime() + delay);
      expect(outbox.isDue(new Date(now.getTime() - 1))).toBe(false);
      expect(outbox.isDue(now)).toBe(true);
    }
  });
  test('publication is terminal and removes retry schedule', () => {
    const outbox = OutboxMessage.enqueue(outboxProps());
    outbox.scheduleRetry(at());
    const publishedAt = later();
    outbox.markPublished(publishedAt);
    publishedAt.setFullYear(2000);
    outbox.publishedAt?.setFullYear(2000);
    expect(outbox.publishedAt).toEqual(later());
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(later())).toBe(false);
    expect(outbox.nextAttemptAt).toBeUndefined();
    expect(() => outbox.markPublished(later())).toThrow(DomainError);
    expect(() => outbox.scheduleRetry(later())).toThrow(DomainError);
  });
  test('failed retry validation leaves the schedule unchanged', () => {
    const outbox = OutboxMessage.enqueue(outboxProps());
    for (const policy of [
      { baseDelayMs: 0, maxDelayMs: 10 },
      { baseDelayMs: 20, maxDelayMs: 10 },
      { baseDelayMs: 1.5, maxDelayMs: 10 },
      { baseDelayMs: 1, maxDelayMs: Infinity },
    ]) {
      expect(() => outbox.scheduleRetry(at(), policy)).toThrow(DomainError);
      expect(outbox.attempts).toBe(0);
      expect(outbox.nextAttemptAt).toBeUndefined();
    }
    outbox.scheduleRetry(at());
    expect(() => outbox.scheduleRetry(at())).toThrow(DomainError);
    expect(outbox.attempts).toBe(1);
  });
  test('copies and deeply freezes payloads, arrays and dates', () => {
    const props = outboxProps();
    const outbox = OutboxMessage.enqueue(props);
    props.payload.data.money.amount = '999.99';
    props.payload.tags.push('changed');
    props.occurredAt.setFullYear(2000);
    outbox.occurredAt.setFullYear(2000);
    expect(outbox.payload).toEqual(outboxProps().payload);
    expect(Object.isFrozen(outbox.payload)).toBe(true);
    expect(Object.isFrozen(outbox.payload['data'])).toBe(true);
    expect(Object.isFrozen(outbox.payload['tags'])).toBe(true);
    expect(outbox.occurredAt).toEqual(at());
    outbox.scheduleRetry(at());
    outbox.nextAttemptAt?.setFullYear(2000);
    expect(outbox.nextAttemptAt?.getTime()).toBe(at().getTime() + 1000);
  });
  test.each([undefined, 1n, NaN, Infinity, new Date(), () => 1])(
    'rejects non-JSON payload value %s',
    (value) => {
      expect(() =>
        OutboxMessage.enqueue({ ...outboxProps(), payload: { value } as unknown as JsonObject }),
      ).toThrow(DomainError);
    },
  );
  test('rejects cycles but allows shared acyclic objects', () => {
    const cycle: Record<string, JsonValue> = {};
    cycle['self'] = cycle;
    expect(() => OutboxMessage.enqueue({ ...outboxProps(), payload: cycle })).toThrow(DomainError);
    const child = { value: 'ok' };
    expect(
      OutboxMessage.enqueue({ ...outboxProps(), payload: { a: child, b: child } }).payload,
    ).toEqual({ a: child, b: child });
  });
  test('rehydrates pending and published snapshots preserving attempts', () => {
    const pending = OutboxMessage.rehydrate({
      ...outboxProps(),
      attempts: 3,
      nextAttemptAt: later(),
    });
    expect(pending.attempts).toBe(3);
    expect(pending.isDue(at())).toBe(false);
    expect(pending.isDue(later())).toBe(true);
    const published = OutboxMessage.rehydrate({
      ...outboxProps(),
      attempts: 3,
      publishedAt: later(),
    });
    expect(published.isPending()).toBe(false);
    expect(published.attempts).toBe(3);
  });
  test('rejects inconsistent snapshots and counter overflow', () => {
    expect(() => OutboxMessage.rehydrate({ ...outboxProps(), attempts: -1 })).toThrow(DomainError);
    expect(() =>
      OutboxMessage.rehydrate({ ...outboxProps(), attempts: 0, nextAttemptAt: later() }),
    ).toThrow(DomainError);
    expect(() =>
      OutboxMessage.rehydrate({
        ...outboxProps(),
        attempts: 1,
        nextAttemptAt: later(),
        publishedAt: later(),
      }),
    ).toThrow(DomainError);
    const outbox = OutboxMessage.rehydrate({ ...outboxProps(), attempts: Number.MAX_SAFE_INTEGER });
    expect(() => outbox.scheduleRetry(at())).toThrow(DomainError);
    expect(outbox.attempts).toBe(Number.MAX_SAFE_INTEGER);
  });
});
