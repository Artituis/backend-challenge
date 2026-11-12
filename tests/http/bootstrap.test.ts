import 'reflect-metadata';

import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, expect, test } from 'bun:test';

import { HealthService } from '../../src/infrastructure/health/health.module';
import { Api } from '../../src/infrastructure/http/api';
import { createHttpApplication } from '../../src/infrastructure/http/bootstrap';
import { ApiController } from '../../src/infrastructure/http/controller';
import { LoggingModule } from '../../src/infrastructure/observability/logging.module';
import { bindTrace, trace } from '../../src/infrastructure/observability/telemetry';
import {
  createWalletSchema,
  submitTransactionSchema,
  transactionHeadersSchema,
} from '../../src/infrastructure/validation/contracts';

const received: unknown[] = [];
class TestModule {}
Module({
  imports: [LoggingModule],
  controllers: [ApiController],
  providers: [
    {
      provide: HealthService,
      useValue: new HealthService(
        async () => undefined,
        async () => undefined,
      ),
    },
    {
      provide: Api,
      useValue: {
        handle: async (request: Request) => {
          const input: unknown = await request.json();
          if (new URL(request.url).pathname === '/wallets') createWalletSchema.parse(input);
          else {
            submitTransactionSchema.parse(input);
            transactionHeadersSchema.parse(Object.fromEntries(request.headers));
          }
          received.push(input);
          bindTrace({ walletId: 'wallet', transactionId: 'tx', providerId: 'provider' });
          return Response.json({ correlationId: trace().correlationId }, { status: 201 });
        },
      },
    },
  ],
})(TestModule);
let app: NestExpressApplication;
let base: string;
beforeAll(async () => {
  app = await createHttpApplication(TestModule);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
});
test('Nest serves Swagger UI and every documented route, including required Idempotency-Key', async () => {
  expect((await fetch(`${base}/docs`)).status).toBe(200);
  const document = (await (await fetch(`${base}/docs-json`)).json()) as {
    paths: Record<
      string,
      { post?: { parameters: { name: string; required: boolean }[]; requestBody: unknown } }
    >;
  };
  for (const path of [
    '/wallets',
    '/wallets/{walletId}',
    '/wallets/{walletId}/ledger',
    '/wallets/{walletId}/reconciliation',
    '/wagering/transactions',
    '/wagering/transactions/{transactionId}',
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
    '/health',
    '/health/live',
    '/health/ready',
    '/metrics',
  ])
    expect(document.paths[path]).toBeDefined();
  expect(
    document.paths['/wagering/transactions']?.post?.parameters.find(
      (parameter) => parameter.name === 'Idempotency-Key',
    )?.required,
  ).toBe(true);
  expect(document.paths['/wallets']?.post?.requestBody).toBeDefined();
  expect((await fetch(`${base}/health`)).status).toBe(200);
});
test('real HTTP adapter preserves bodies and correlation and rejects invalid JSON/contracts', async () => {
  const send = (body: string) =>
    fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-http' },
      body,
    });
  const response = await send(
    JSON.stringify({ playerId: 'player', initialBalance: { amount: '1.00', currency: 'BRL' } }),
  );
  expect(response.status).toBe(201);
  expect(response.headers.get('x-correlation-id')).toBe('corr-http');
  expect(received).toHaveLength(1);
  for (const body of [
    '{',
    '{}',
    JSON.stringify({ playerId: 'player', initialBalance: { amount: 1, currency: 'BRL' } }),
  ]) {
    const invalid = await send(body);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: 'INVALID_PAYLOAD',
      correlationId: 'corr-http',
    });
  }
  expect(received).toHaveLength(1);
  expect((await fetch(`${base}/missing`)).status).toBe(404);
  const oversized = await send(JSON.stringify({ playerId: 'x'.repeat(65 * 1024) }));
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({
    code: 'INVALID_PAYLOAD',
    correlationId: 'corr-http',
  });
});
