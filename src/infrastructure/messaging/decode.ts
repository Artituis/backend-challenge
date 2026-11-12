import type { WagerCommand } from '../../application/wagering/contracts';
import { DomainError, FailureCode } from '../../domain';
import { sqsWagerSchema } from '../validation/contracts';

export class InvalidEnvelopeError extends Error {}
export function decodeWager(body: string, consumerName: string, messageId: string): WagerCommand {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidEnvelopeError('Invalid JSON');
  }
  const parsed = sqsWagerSchema.safeParse(value);
  if (!parsed.success) throw new InvalidEnvelopeError('Invalid SQS payload');
  const { referenceExternalTransactionId, correlationId, ...input } = parsed.data;
  return {
    ...input,
    correlationId: correlationId ?? messageId,
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    delivery: { consumerName, messageId },
  };
}

const terminal = new Set([
  FailureCode.InsufficientFunds,
  FailureCode.ReversalInsufficientFunds,
  FailureCode.CurrencyMismatch,
  FailureCode.InvalidReference,
  FailureCode.AlreadyReversed,
]);
export function classify(error: unknown): 'terminal' | 'permanent' | 'transient' {
  if (error instanceof DomainError) return terminal.has(error.code) ? 'terminal' : 'permanent';
  if (error instanceof InvalidEnvelopeError) return 'permanent';
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    (/^(22|23)/.test(error.code) || error.code === '42501')
  )
    return 'permanent';
  // Unknown errors, connectivity failures and ambiguous commits retry safely via inbox.
  return 'transient';
}
export function reason(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  return error instanceof Error ? error.name : 'UnknownError';
}
