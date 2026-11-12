import { FailureCode, invariant } from './errors';

export function identifier(value: string, field: string): void {
  invariant(
    typeof value === 'string' && value.length > 0 && value.trim() === value,
    FailureCode.InvalidPayload,
    `${field} must be a nonempty string without surrounding whitespace`,
  );
}

export function date(value: Date): Date {
  invariant(
    value instanceof Date && Number.isFinite(value.getTime()),
    FailureCode.InvalidPayload,
    'Invalid date',
  );
  return new Date(value.getTime());
}

export function dateAfter(value: Date, since: Date): Date {
  const copy = date(value);
  invariant(
    copy.getTime() >= since.getTime(),
    FailureCode.InvalidPayload,
    'Date precedes previous state',
  );
  return copy;
}

export function counter(value: number, minimum = 0): void {
  invariant(
    Number.isSafeInteger(value) && value >= minimum,
    FailureCode.InvalidPayload,
    'Invalid counter',
  );
}
