import { FailureCode, InvalidTransactionStateError, invariant } from './errors';
import type { Money } from './money';
import { date, dateAfter, identifier } from './validation';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK',
}
export enum WagerTransactionStatus {
  Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE', Processed = 'PROCESSED', Rejected = 'REJECTED', Failed = 'FAILED',
}
export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}
export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
}

export class WagerTransaction {
  readonly #props: CreateWagerTransactionProps;
  #status: WagerTransactionStatus;
  #referenceTransactionId: string | undefined;
  #failureCode: FailureCode | undefined;
  #processedAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.#props = Object.freeze({ ...state, createdAt: date(state.createdAt) });
    this.#status = state.status;
    this.#referenceTransactionId = state.referenceTransactionId;
    this.#failureCode = state.failureCode;
    this.#processedAt = state.processedAt === undefined ? undefined : dateAfter(state.processedAt, state.createdAt);
    Object.freeze(this);
  }
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    invariant(props.kind !== WagerTransactionKind.Opening, FailureCode.InvalidPayload, 'OPENING is internal only');
    WagerTransaction.validatePayload(props);
    return new WagerTransaction(WagerTransaction.initialState(props));
  }
  /** Application must expose only create() to untrusted HTTP / queue input. */
  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    const opening = { ...props, kind: WagerTransactionKind.Opening };
    WagerTransaction.validatePayload(opening);
    return new WagerTransaction(WagerTransaction.initialState(opening));
  }
  private static initialState(props: CreateWagerTransactionProps): WagerTransactionState {
    // Explicit projection keeps persisted metadata out of the creation path,
    // even when callers pass a wider, structurally compatible object.
    return {
      id: props.id, providerId: props.providerId, externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey, payloadHash: props.payloadHash,
      walletId: props.walletId, playerId: props.playerId, roundId: props.roundId, gameId: props.gameId,
      kind: props.kind, money: props.money, createdAt: props.createdAt,
      ...(props.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: props.referenceExternalTransactionId }),
      status: WagerTransactionStatus.Pending,
    };
  }
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    WagerTransaction.validatePayload(state);
    invariant(Object.values(WagerTransactionStatus).includes(state.status), FailureCode.InvalidState, 'Unknown status');
    const processed = state.status === WagerTransactionStatus.Processed;
    const failed = state.status === WagerTransactionStatus.Rejected || state.status === WagerTransactionStatus.Failed;
    invariant(processed === (state.processedAt !== undefined) && failed === (state.failureCode !== undefined),
      FailureCode.InvalidState, 'Inconsistent persisted terminal metadata');
    if (state.failureCode !== undefined) invariant(Object.values(FailureCode).includes(state.failureCode), FailureCode.InvalidPayload, 'Unknown failure code');
    if (state.referenceTransactionId !== undefined) identifier(state.referenceTransactionId, 'referenceTransactionId');
    invariant((processed && state.referenceExternalTransactionId !== undefined) === (state.referenceTransactionId !== undefined),
      FailureCode.InvalidState, 'Inconsistent persisted reference');
    invariant(state.status !== WagerTransactionStatus.PendingReference || state.referenceExternalTransactionId !== undefined,
      FailureCode.InvalidState, 'Pending reference requires an external reference');
    // Restore a snapshot directly; never replay transitions or query the referenced aggregate.
    return new WagerTransaction(state);
  }
  private static validatePayload(props: CreateWagerTransactionProps): void {
    for (const field of ['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash',
      'walletId', 'playerId', 'roundId', 'gameId'] as const) identifier(props[field], field);
    invariant(Object.values(WagerTransactionKind).includes(props.kind), FailureCode.InvalidPayload, 'Unknown transaction kind');
    invariant(!props.money.isNegative(), FailureCode.InvalidMoney, 'Incoming amount cannot be negative');
    invariant(props.kind === WagerTransactionKind.Loss ? props.money.isZero() : props.money.isPositive(),
      FailureCode.InvalidPayload, 'LOSS requires zero; financial operations require a positive amount');
    const needsReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    invariant(!needsReference || props.referenceExternalTransactionId !== undefined, FailureCode.InvalidReference, 'Reference is required');
    if (props.referenceExternalTransactionId !== undefined) {
      identifier(props.referenceExternalTransactionId, 'referenceExternalTransactionId');
      invariant(props.kind !== WagerTransactionKind.Bet && props.kind !== WagerTransactionKind.Opening,
        FailureCode.InvalidReference, 'This kind cannot reference another transaction');
      invariant(props.referenceExternalTransactionId !== props.externalTransactionId, FailureCode.InvalidReference, 'Self-reference is forbidden');
    }
    date(props.createdAt);
  }
  get id(): string { return this.#props.id; }
  get providerId(): string { return this.#props.providerId; }
  get externalTransactionId(): string { return this.#props.externalTransactionId; }
  get idempotencyKey(): string { return this.#props.idempotencyKey; }
  get payloadHash(): string { return this.#props.payloadHash; }
  get walletId(): string { return this.#props.walletId; }
  get playerId(): string { return this.#props.playerId; }
  get roundId(): string { return this.#props.roundId; }
  get gameId(): string { return this.#props.gameId; }
  get kind(): WagerTransactionKind { return this.#props.kind; }
  get money(): Money { return this.#props.money; }
  get referenceExternalTransactionId(): string | undefined { return this.#props.referenceExternalTransactionId; }
  get createdAt(): Date { return date(this.#props.createdAt); }
  get status(): WagerTransactionStatus { return this.#status; }
  get referenceTransactionId(): string | undefined { return this.#referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.#failureCode; }
  get processedAt(): Date | undefined { return this.#processedAt === undefined ? undefined : date(this.#processedAt); }
  isTerminal(): boolean {
    return this.#status === WagerTransactionStatus.Processed || this.#status === WagerTransactionStatus.Rejected || this.#status === WagerTransactionStatus.Failed;
  }
  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  requiresReference(): boolean { return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback; }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }
  assertIdempotentReplay(input: Pick<CreateWagerTransactionProps, 'providerId' | 'externalTransactionId' | 'idempotencyKey' | 'payloadHash'>): void {
    invariant(input.providerId === this.providerId && input.externalTransactionId === this.externalTransactionId
      && input.idempotencyKey === this.idempotencyKey && this.matchesPayload(input.payloadHash),
    FailureCode.IdempotencyConflict, 'Idempotency identity or payload differs');
  }
  markPendingReference(): void {
    this.assertMutable();
    invariant(this.referenceExternalTransactionId !== undefined, FailureCode.InvalidReference, 'No reference to await');
    this.#status = WagerTransactionStatus.PendingReference;
  }
  markProcessed(reference: WagerTransaction | undefined, at: Date): void {
    this.assertMutable();
    this.assertReference(reference);
    const processedAt = dateAfter(at, this.#props.createdAt);
    this.#referenceTransactionId = reference?.id;
    this.#processedAt = processedAt;
    this.#status = WagerTransactionStatus.Processed;
  }
  reject(code: FailureCode): void { this.finish(WagerTransactionStatus.Rejected, code); }
  fail(code: FailureCode): void { this.finish(WagerTransactionStatus.Failed, code); }
  private finish(status: WagerTransactionStatus.Rejected | WagerTransactionStatus.Failed, code: FailureCode): void {
    this.assertMutable();
    invariant(Object.values(FailureCode).includes(code), FailureCode.InvalidPayload, 'Unknown failure code');
    this.#failureCode = code;
    this.#status = status;
  }
  private assertMutable(): void { if (this.isTerminal()) throw new InvalidTransactionStateError(this.#status); }
  private assertReference(reference: WagerTransaction | undefined): void {
    if (this.referenceExternalTransactionId === undefined) {
      invariant(reference === undefined, FailureCode.InvalidReference, 'Unexpected reference');
      return;
    }
    invariant(reference !== undefined, FailureCode.ReferenceNotFound, 'Reference not found');
    invariant(reference.id !== this.id && reference.externalTransactionId === this.referenceExternalTransactionId
      && reference.providerId === this.providerId && reference.playerId === this.playerId
      && reference.walletId === this.walletId && reference.roundId === this.roundId,
    FailureCode.InvalidReference, 'Reference must belong to the same provider, player, wallet and round');
    invariant(reference.money.currency === this.money.currency, FailureCode.CurrencyMismatch, 'Reference currency differs');
    invariant(reference.status === WagerTransactionStatus.Processed, FailureCode.InvalidReference, 'Reference must be processed');
    const allowed = this.kind === WagerTransactionKind.Rollback
      ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund] : [WagerTransactionKind.Bet];
    invariant(allowed.includes(reference.kind), FailureCode.InvalidReference, 'Reference kind is not allowed');
    if (this.requiresReference()) invariant(this.money.equals(reference.money), FailureCode.InvalidReference, 'Partial reversals are forbidden');
  }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    invariant(this.affectsBalance(), FailureCode.InvalidLedger, 'LOSS has no ledger direction');
    this.assertReference(reference);
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if (this.kind === WagerTransactionKind.Rollback) {
      return reference?.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
    return LedgerDirection.Credit;
  }
  /** Canonical business JSON, suitable for SHA-256 in the application adapter. */
  static canonicalPayload(props: CreateWagerTransactionProps): string {
    WagerTransaction.validatePayload(props);
    // Keys sorted lexicographically, including nested Money; transport metadata is excluded.
    return JSON.stringify({ externalTransactionId: props.externalTransactionId, gameId: props.gameId,
      kind: props.kind, money: props.money.toJSON(), playerId: props.playerId, providerId: props.providerId,
      referenceExternalTransactionId: props.referenceExternalTransactionId ?? null, roundId: props.roundId, walletId: props.walletId });
  }
}
