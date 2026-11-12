import { describe, expect, test } from 'bun:test';

import type { CreateWagerTransactionProps, WagerTransactionState } from '../../src/domain';
import {
  DomainError,
  FailureCode,
  InvalidTransactionStateError,
  LedgerDirection,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain';
import { at, later, money, processedBet, transaction, transactionProps } from './fixtures';

const dependent = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  transaction({
    id: 'tx-2',
    externalTransactionId: 'ext-2',
    idempotencyKey: 'key-2',
    kind: Kind.Refund,
    referenceExternalTransactionId: 'ext-1',
    ...overrides,
  });

describe('WagerTransaction payload', () => {
  test('starts pending with no terminal metadata', () => {
    const tx = transaction();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
  });
  test('creation cannot inherit terminal metadata from a wider input object', () => {
    const stored = {
      ...transactionProps(),
      status: Status.Processed,
      processedAt: later(),
      referenceTransactionId: 'stored-ref',
      failureCode: FailureCode.InvalidPayload,
    };
    for (const tx of [WagerTransaction.create(stored), WagerTransaction.createOpening(stored)]) {
      expect(tx.status).toBe(Status.Pending);
      expect(tx.processedAt).toBeUndefined();
      expect(tx.failureCode).toBeUndefined();
      expect(tx.referenceTransactionId).toBeUndefined();
    }
  });
  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])(
    '%s requires positive input',
    (kind) => {
      for (const amount of ['0', '-1'])
        expect(() =>
          transaction({
            kind,
            money: money(amount),
            ...(kind === Kind.Refund || kind === Kind.Rollback
              ? { referenceExternalTransactionId: 'ref' }
              : {}),
          }),
        ).toThrow(DomainError);
    },
  );
  test('LOSS records a zero-value outcome with no ledger', () => {
    const loss = transaction({ kind: Kind.Loss, money: money('0') });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(DomainError);
    loss.markProcessed(undefined, later());
    expect(loss.status).toBe(Status.Processed);
    expect(() => transaction({ kind: Kind.Loss, money: money('1') })).toThrow(DomainError);
  });
  test('OPENING is rejected by the public factory and available only through an explicit internal factory', () => {
    expect(() => transaction({ kind: Kind.Opening })).toThrow(DomainError);
    const tx = WagerTransaction.createOpening(transactionProps());
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    tx.markProcessed(undefined, later());
    expect(tx.status).toBe(Status.Processed);
  });
  test.each([
    'id',
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'payloadHash',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
  ] as const)('rejects empty %s', (field) => {
    expect(() => transaction({ [field]: '' })).toThrow(DomainError);
    expect(() => transaction({ [field]: '  ' })).toThrow(DomainError);
  });
  test.each([Kind.Refund, Kind.Rollback])('%s requires a nonempty external reference', (kind) => {
    expect(() => transaction({ kind })).toThrow(DomainError);
    expect(() => transaction({ kind, referenceExternalTransactionId: '' })).toThrow(DomainError);
    expect(() => transaction({ kind, referenceExternalTransactionId: 'ext-1' })).toThrow(
      DomainError,
    );
  });
  test('rejects unknown kind, a BET reference and invalid timestamp', () => {
    expect(() => transaction({ kind: 'UNKNOWN' as Kind })).toThrow(DomainError);
    expect(() => transaction({ referenceExternalTransactionId: 'another' })).toThrow(DomainError);
    expect(() => transaction({ createdAt: new Date('invalid') })).toThrow(DomainError);
  });
});

describe('WagerTransaction state machine', () => {
  const actions = {
    processed: (tx: WagerTransaction) => tx.markProcessed(processedBet(), later()),
    pendingReference: (tx: WagerTransaction) => tx.markPendingReference(),
    rejected: (tx: WagerTransaction) => tx.reject(FailureCode.ReferenceNotFound),
    failed: (tx: WagerTransaction) => tx.fail(FailureCode.PermanentInfrastructureFailure),
  };
  test.each([false, true])('supports every allowed exit from pendingReference=%s', (waiting) => {
    for (const [action, expected] of [
      ['processed', Status.Processed],
      ['pendingReference', Status.PendingReference],
      ['rejected', Status.Rejected],
      ['failed', Status.Failed],
    ] as const) {
      const tx = dependent();
      if (waiting) tx.markPendingReference();
      actions[action](tx);
      expect(tx.status).toBe(expected);
      expect(tx.isTerminal()).toBe(expected !== Status.PendingReference);
    }
  });
  test.each(['processed', 'rejected', 'failed'] as const)(
    'forbids all transitions from terminal %s',
    (terminal) => {
      for (const action of Object.values(actions)) {
        const tx = dependent();
        actions[terminal](tx);
        const before = {
          status: tx.status,
          processedAt: tx.processedAt,
          reference: tx.referenceTransactionId,
          failure: tx.failureCode,
        };
        expect(() => action(tx)).toThrow(InvalidTransactionStateError);
        expect({
          status: tx.status,
          processedAt: tx.processedAt,
          reference: tx.referenceTransactionId,
          failure: tx.failureCode,
        }).toEqual(before);
      }
    },
  );
  test('pending reference requires a declared reference', () => {
    const tx = transaction();
    expect(() => tx.markPendingReference()).toThrow(DomainError);
    expect(tx.status).toBe(Status.Pending);
  });
  test('failed validation does not partially transition or record metadata', () => {
    const tx = dependent();
    expect(() => tx.markProcessed(undefined, later())).toThrow(DomainError);
    expect(() => tx.markProcessed(processedBet(), new Date('2025-01-01'))).toThrow(DomainError);
    expect(() => tx.reject('BAD' as FailureCode)).toThrow(DomainError);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
  });
  test('protects timestamps and readonly identity', () => {
    const createdAt = at();
    const tx = transaction({ createdAt });
    const processedAt = later();
    tx.markProcessed(undefined, processedAt);
    createdAt.setFullYear(2000);
    processedAt.setFullYear(2000);
    tx.createdAt.setFullYear(2000);
    tx.processedAt?.setFullYear(2000);
    expect(tx.createdAt).toEqual(at());
    expect(tx.processedAt).toEqual(later());
    expect(Reflect.set(tx, 'status', Status.Pending)).toBe(false);
  });
  test.each(Object.values(Status))(
    'rehydrates %s directly without executing transitions',
    (status) => {
      const props = transactionProps({
        id: 'tx-2',
        externalTransactionId: 'ext-2',
        kind: Kind.Refund,
        referenceExternalTransactionId: 'ext-1',
      });
      const state: WagerTransactionState = {
        ...props,
        status,
        ...(status === Status.Processed
          ? { processedAt: later(), referenceTransactionId: 'stored-reference-id' }
          : {}),
        ...(status === Status.Rejected || status === Status.Failed
          ? { failureCode: FailureCode.ReferenceNotFound }
          : {}),
      };
      const tx = WagerTransaction.rehydrate(state);
      expect(tx.status).toBe(status);
      expect(tx.referenceTransactionId).toBe(state.referenceTransactionId);
      expect(tx.failureCode).toBe(state.failureCode);
      expect(tx.processedAt).toEqual(state.processedAt);
    },
  );
  test('rejects structurally inconsistent persisted states', () => {
    const props = transactionProps();
    for (const metadata of [
      { status: 'BAD' as Status },
      { status: Status.Processed },
      { status: Status.Rejected },
      { status: Status.PendingReference },
      { status: Status.Pending, processedAt: later() },
      { status: Status.Pending, failureCode: FailureCode.InvalidPayload },
      { status: Status.Processed, processedAt: later(), referenceTransactionId: 'unexpected' },
    ])
      expect(() => WagerTransaction.rehydrate({ ...props, ...metadata })).toThrow(DomainError);
  });
});

describe('references and reversal rules', () => {
  test('refund resolves to a full credit against a processed bet', () => {
    const refund = dependent();
    expect(refund.requiresReference()).toBe(true);
    expect(refund.ledgerDirectionFor(processedBet())).toBe(LedgerDirection.Credit);
    refund.markPendingReference();
    refund.markProcessed(processedBet(), later());
    expect(refund.referenceTransactionId).toBe('tx-1');
    expect(refund.processedAt).toEqual(later());
  });
  test.each([Kind.Bet, Kind.Win, Kind.Refund])('rollback reverses %s direction', (kind) => {
    const ref = kind === Kind.Refund ? dependent() : transaction({ kind });
    ref.markProcessed(kind === Kind.Refund ? processedBet() : undefined, at());
    const rollback = dependent({
      id: 'rollback',
      externalTransactionId: 'ext-rollback',
      kind: Kind.Rollback,
      referenceExternalTransactionId: ref.externalTransactionId,
    });
    expect(rollback.ledgerDirectionFor(ref)).toBe(
      kind === Kind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit,
    );
    rollback.markProcessed(ref, later());
    expect(rollback.status).toBe(Status.Processed);
  });
  test.each(['providerId', 'playerId', 'walletId', 'roundId', 'externalTransactionId'] as const)(
    'rejects a reference with a different %s',
    (field) => {
      const ref = transaction({ [field]: 'different' });
      ref.markProcessed(undefined, at());
      expect(() => dependent().markProcessed(ref, later())).toThrow(DomainError);
    },
  );
  test('rejects reference currency, amount, kind and status conflicts', () => {
    expect(() =>
      dependent({ money: money('25', 'USD') }).markProcessed(processedBet(), later()),
    ).toThrow(DomainError);
    expect(() =>
      dependent({ money: money('24.99') }).markProcessed(processedBet(), later()),
    ).toThrow(DomainError);
    const win = transaction({ kind: Kind.Win });
    win.markProcessed(undefined, at());
    expect(() => dependent().markProcessed(win, later())).toThrow(DomainError);
    for (const status of [
      Status.Pending,
      Status.PendingReference,
      Status.Rejected,
      Status.Failed,
    ]) {
      const ref = WagerTransaction.rehydrate({
        ...transactionProps({
          kind: Kind.Win,
          ...(status === Status.PendingReference
            ? { referenceExternalTransactionId: 'missing' }
            : {}),
        }),
        status,
        ...(status === Status.Rejected || status === Status.Failed
          ? { failureCode: FailureCode.InvalidReference }
          : {}),
      });
      expect(() => dependent({ kind: Kind.Rollback }).markProcessed(ref, later())).toThrow(
        DomainError,
      );
    }
  });
  test('rollback cannot target LOSS, OPENING or another ROLLBACK', () => {
    const loss = transaction({ kind: Kind.Loss, money: money('0') });
    const opening = WagerTransaction.createOpening(transactionProps());
    const rollback = dependent({ kind: Kind.Rollback });
    loss.markProcessed(undefined, at());
    opening.markProcessed(undefined, at());
    rollback.markProcessed(processedBet(), at());
    for (const ref of [loss, opening, rollback]) {
      const tx = dependent({
        id: 'tx-3',
        externalTransactionId: 'ext-3',
        kind: Kind.Rollback,
        referenceExternalTransactionId: ref.externalTransactionId,
      });
      expect(() => tx.markProcessed(ref, later())).toThrow(DomainError);
    }
  });
  test('WIN and LOSS may reference a BET; WIN amount need not equal the bet', () => {
    const win = dependent({ kind: Kind.Win, money: money('50') });
    expect(win.ledgerDirectionFor(processedBet())).toBe(LedgerDirection.Credit);
    win.markProcessed(processedBet(), later());
    const loss = dependent({ kind: Kind.Loss, money: money('0') });
    loss.markPendingReference();
    loss.markProcessed(processedBet(), later());
    expect(loss.status).toBe(Status.Processed);
  });
  test('rejects unexpected and same-internal-ID references', () => {
    expect(() => transaction().markProcessed(processedBet(), later())).toThrow(DomainError);
    expect(() => dependent({ id: 'tx-1' }).markProcessed(processedBet(), later())).toThrow(
      DomainError,
    );
  });
});

describe('idempotency', () => {
  test('identical replay passes without mutating the original result', () => {
    const tx = processedBet();
    tx.assertIdempotentReplay(transactionProps());
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(at());
    expect(tx.matchesPayload('different')).toBe(false);
  });
  test.each(['providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash'] as const)(
    'conflicting %s is not a replay',
    (field) => {
      expect(() =>
        transaction().assertIdempotentReplay({ ...transactionProps(), [field]: 'different' }),
      ).toThrow(expect.objectContaining({ code: FailureCode.IdempotencyConflict }));
    },
  );
  test('canonical payload normalizes money and excludes transport fields', () => {
    const expected = WagerTransaction.canonicalPayload(transactionProps());
    expect(
      WagerTransaction.canonicalPayload(
        transactionProps({
          id: 'new-id',
          idempotencyKey: 'new-key',
          payloadHash: 'new-hash',
          createdAt: later(),
          money: money('025.0'),
        }),
      ),
    ).toBe(expected);
    const parsed = JSON.parse(expected) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(Object.keys(parsed).sort());
    expect(Object.keys(parsed['money'] as object)).toEqual(['amount', 'currency']);
    expect(expected).not.toContain('payloadHash');
  });
  test('all business fields affect canonical payload', () => {
    const base = transactionProps({ kind: Kind.Win });
    const original = WagerTransaction.canonicalPayload(base);
    const changes: Partial<CreateWagerTransactionProps>[] = [
      { providerId: 'other' },
      { externalTransactionId: 'other' },
      { playerId: 'other' },
      { walletId: 'other' },
      { roundId: 'other' },
      { gameId: 'other' },
      { kind: Kind.Bet },
      { money: money('26') },
      { money: money('25', 'USD') },
      { referenceExternalTransactionId: 'ref' },
    ];
    for (const change of changes)
      expect(WagerTransaction.canonicalPayload({ ...base, ...change })).not.toBe(original);
  });
});
