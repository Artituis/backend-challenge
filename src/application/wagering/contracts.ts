import type { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../../domain';

export type WagerKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

export interface WagerCommand {
  readonly correlationId?: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string;
  /** Set only by the queue adapter; receipt handles and delivery counts are excluded. */
  readonly delivery?: { readonly consumerName: string; readonly messageId: string };
}

/** Persisted independently of the current wallet balance, including rejected/accepted results. */
export interface WagerResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly walletVersion: number;
  readonly failureCode: FailureCode | null;
}
export interface WagerResponse extends WagerResult { readonly idempotentReplay: boolean; }

export interface ApplicationRuntime {
  id(): string;
  now(): Date;
  sha256(value: string): string;
  pause(milliseconds: number): Promise<void>;
  random(): number;
}
export const APPLICATION_RUNTIME = Symbol('APPLICATION_RUNTIME');

/** Only infrastructure errors known to have rolled back are safe to retry. */
export class RetryableTransactionError extends Error {
  constructor(cause: unknown) { super('Transaction rolled back; retry the entire operation', { cause }); }
}
