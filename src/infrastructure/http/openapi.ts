import type { INestApplication } from '@nestjs/common';
import { applyDecorators } from '@nestjs/common';
import type { ApiBodyOptions } from '@nestjs/swagger';
import { ApiHeader, ApiResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { z } from 'zod';

import { moneySchema } from '../validation/contracts';

type BodySchema = Extract<ApiBodyOptions, { schema: unknown }>['schema'];
export function apiSchema(schema: z.ZodType): BodySchema {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input' }) as BodySchema;
}
const wallet = z.object({
  id: z.uuid(),
  playerId: z.string(),
  balance: moneySchema,
  version: z.number().int(),
});
const outcome = z.object({
  transactionId: z.uuid(),
  status: z.enum(['PROCESSED', 'REJECTED', 'FAILED', 'PENDING_REFERENCE']),
  balance: moneySchema,
  walletVersion: z.number().int(),
  failureCode: z.string().nullable(),
  idempotentReplay: z.boolean(),
});
const transaction = z.object({
  transactionId: z.uuid(),
  providerId: z.string(),
  externalTransactionId: z.string(),
  walletId: z.uuid(),
  kind: z.enum(['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  status: z.string(),
  failureCode: z.string().nullable(),
  money: moneySchema,
  createdAt: z.iso.datetime(),
  processedAt: z.iso.datetime().nullable(),
});
const ledger = z.object({
  entries: z.array(
    z.object({
      id: z.uuid(),
      transactionId: z.uuid(),
      walletId: z.uuid(),
      walletVersion: z.number().int(),
      direction: z.enum(['CREDIT', 'DEBIT']),
      money: moneySchema,
      balanceBefore: moneySchema,
      balanceAfter: moneySchema,
      createdAt: z.iso.datetime(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const reconciliation = z.object({
  walletId: z.uuid(),
  storedBalance: moneySchema,
  calculatedBalance: moneySchema,
  difference: moneySchema,
  consistent: z.boolean(),
  checkedEntries: z.string(),
});
const live = z.object({ status: z.literal('ok') });
const ready = z.object({
  status: z.enum(['ok', 'unavailable']),
  dependencies: z.object({ postgres: z.enum(['up', 'down']), sqs: z.enum(['up', 'down']) }),
});
export const responses = { wallet, outcome, transaction, ledger, reconciliation, live, ready };
export function ApiErrors(): ClassDecorator & MethodDecorator {
  const schema = apiSchema(z.object({ code: z.string(), correlationId: z.string() }));
  return applyDecorators(
    ApiHeader({
      name: 'X-Correlation-Id',
      required: false,
      description: 'Opaque tracing identifier; generated when absent or invalid.',
    }),
    ...[400, 404, 409, 422, 500, 503].map((status) =>
      ApiResponse({
        status,
        schema,
        description: 'Stable error code; payloads and exception details are never echoed.',
      }),
    ),
  );
}
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor')
    .setVersion('1.0.0')
    .setDescription(
      'Money uses decimal strings. Provider authentication is currently no-op. Reuse Idempotency-Key only for an identical transaction. REFUND/ROLLBACK require referenceExternalTransactionId; LOSS uses zero, other wagers use positive amounts.',
    )
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { persistAuthorization: false, displayRequestDuration: true },
  });
}
