import { DomainError, FailureCode, WagerTransactionKind } from '../../domain';
import type { WagerCommand, WagerKind } from '../../application/wagering/contracts';

export class InvalidEnvelopeError extends Error {}
export function decodeWager(body: string, consumerName: string, messageId: string): WagerCommand {
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new InvalidEnvelopeError('Invalid JSON'); }
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidEnvelopeError('Expected object');
    return input as Record<string, unknown>;
  };
  const input = object(value);
  const string = (obj: Record<string, unknown>, key: string): string => {
    const result = obj[key];
    if (typeof result !== 'string' || result.length === 0) throw new InvalidEnvelopeError(`Invalid ${key}`);
    return result;
  };
  const kind = string(input, 'kind');
  if (kind === WagerTransactionKind.Opening || !Object.values(WagerTransactionKind).includes(kind as WagerTransactionKind)) {
    throw new InvalidEnvelopeError('Invalid kind');
  }
  const money = object(input['money']);
  return { providerId: string(input, 'providerId'), externalTransactionId: string(input, 'externalTransactionId'),
    idempotencyKey: string(input, 'idempotencyKey'), walletId: string(input, 'walletId'), playerId: string(input, 'playerId'),
    roundId: string(input, 'roundId'), gameId: string(input, 'gameId'), kind: kind as WagerKind,
    money: { amount: string(money, 'amount'), currency: string(money, 'currency') },
    ...(input['referenceExternalTransactionId'] === undefined ? {} : { referenceExternalTransactionId: string(input, 'referenceExternalTransactionId') }),
    delivery: { consumerName, messageId } };
}

const terminal = new Set([FailureCode.InsufficientFunds, FailureCode.ReversalInsufficientFunds,
  FailureCode.CurrencyMismatch, FailureCode.InvalidReference, FailureCode.AlreadyReversed]);
export function classify(error: unknown): 'terminal' | 'permanent' | 'transient' {
  if (error instanceof DomainError) return terminal.has(error.code) ? 'terminal' : 'permanent';
  if (error instanceof InvalidEnvelopeError) return 'permanent';
  if (error instanceof Error && 'code' in error && typeof error.code === 'string'
    && (/^(22|23)/.test(error.code) || error.code === '42501')) return 'permanent';
  // Unknown errors, connectivity failures and ambiguous commits retry safely via inbox.
  return 'transient';
}
export function reason(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  return error instanceof Error ? error.name : 'UnknownError';
}
