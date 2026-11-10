export enum FailureCode {
  InvalidMoney = 'INVALID_MONEY',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InvalidPayload = 'INVALID_PAYLOAD',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  InvalidState = 'INVALID_STATE',
  InvalidReference = 'INVALID_REFERENCE',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  AlreadyReversed = 'ALREADY_REVERSED',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  InvalidLedger = 'INVALID_LEDGER',
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

export class DomainError extends Error {
  constructor(public readonly code: FailureCode, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(status: string) {
    super(FailureCode.InvalidState, `Cannot transition transaction from ${status}`);
  }
}

export function invariant(condition: boolean, code: FailureCode, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
