import { z } from 'zod';

import { WagerTransactionKind } from '../../domain';

export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:@/-]+$/);
export const uuidSchema = z.uuid();
export const moneySchema = z.strictObject({
  amount: z
    .string()
    .max(22)
    .regex(/^-?\d{1,18}(?:\.\d{1,2})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export const createWalletSchema = z.strictObject({
  playerId: identifierSchema,
  initialBalance: moneySchema,
});
export const submitTransactionSchema = z.strictObject({
  providerId: identifierSchema,
  externalTransactionId: identifierSchema,
  walletId: identifierSchema,
  playerId: identifierSchema,
  roundId: identifierSchema,
  gameId: identifierSchema,
  kind: z.enum([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ]),
  money: moneySchema,
  referenceExternalTransactionId: identifierSchema.optional(),
});
export const sqsWagerSchema = submitTransactionSchema.extend({
  idempotencyKey: identifierSchema,
  correlationId: identifierSchema.optional(),
});
export const transactionHeadersSchema = z.object({
  'idempotency-key': identifierSchema,
});
export const ledgerQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(1000))
    .optional(),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
export const ledgerCursorSchema = z.strictObject({
  walletId: uuidSchema,
  version: z.number().int().safe().nonnegative(),
});
export const emptyBodySchema = z.strictObject({});
export type CreateWalletDto = z.infer<typeof createWalletSchema>;
export type SubmitTransactionDto = z.infer<typeof submitTransactionSchema>;
export type SqsWagerDto = z.infer<typeof sqsWagerSchema>;
