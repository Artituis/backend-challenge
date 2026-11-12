import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

import { HealthService } from '../health/health.module';
import { createWalletSchema, submitTransactionSchema } from '../validation/contracts';
import { Api } from './api';
import { ApiErrors, apiSchema, responses } from './openapi';
import { httpHandler } from './server';

type HttpRequest = ExpressRequest<Record<string, string>, unknown, unknown>;
type HttpResponse = ExpressResponse<unknown>;

/** Nest owns routing and documentation; all transports retain the tested application boundary. */
@ApiTags('Wagering')
@ApiErrors()
@Controller()
export class ApiController {
  private readonly handle: (request: Request) => Promise<Response>;
  constructor(@Inject(Api) api: Api, @Inject(HealthService) health: HealthService) {
    this.handle = httpHandler(health, api);
  }
  private async dispatch(request: HttpRequest, response: HttpResponse): Promise<void> {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    }
    const body = request.body;
    const result = await this.handle(
      new Request(new URL(request.originalUrl, 'http://localhost').toString(), {
        method: request.method,
        headers,
        ...(body === undefined || request.method === 'GET' ? {} : { body: JSON.stringify(body) }),
      }),
    );
    response.status(result.status);
    result.headers.forEach((value, key) => response.setHeader(key, value));
    response.send(await result.text());
  }

  @Post('wallets')
  @ApiOperation({ summary: 'Create a wallet with an optional opening credit' })
  @ApiBody({
    schema: apiSchema(createWalletSchema),
    examples: {
      opening: {
        value: { playerId: 'player-1', initialBalance: { amount: '100.00', currency: 'BRL' } },
      },
    },
  })
  @ApiResponse({ status: 201, schema: apiSchema(responses.wallet) })
  createWallet(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    return this.dispatch(req, res);
  }

  @Get('wallets/:walletId')
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, schema: apiSchema(responses.wallet) })
  wallet(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    return this.dispatch(req, res);
  }

  @Get('wallets/:walletId/ledger')
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 1000, default: 50 },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: 'Opaque nextCursor from the previous page, bound to this wallet.',
  })
  @ApiResponse({ status: 200, schema: apiSchema(responses.ledger) })
  ledger(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    return this.dispatch(req, res);
  }

  @Post('wallets/:walletId/reconciliation')
  @ApiParam({ name: 'walletId', format: 'uuid' })
  @ApiResponse({ status: 200, schema: apiSchema(responses.reconciliation) })
  reconcile(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    return this.dispatch(req, res);
  }

  @Post('wagering/transactions')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:@/-]+$' },
  })
  @ApiBody({
    schema: apiSchema(submitTransactionSchema),
    examples: {
      bet: {
        value: {
          providerId: 'provider-a',
          externalTransactionId: 'bet-001',
          walletId: 'REPLACE_WITH_WALLET_ID',
          playerId: 'player-1',
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      },
    },
  })
  @ApiResponse({ status: 200, schema: apiSchema(responses.outcome) })
  @ApiResponse({
    status: 202,
    description: 'Reference pending; persisted for reprocessing.',
    schema: apiSchema(responses.outcome),
  })
  @ApiResponse({
    status: 422,
    description: 'Business rejection.',
    schema: apiSchema(responses.outcome),
  })
  @ApiResponse({
    status: 500,
    description: 'Permanent processing failure.',
    schema: apiSchema(responses.outcome),
  })
  submit(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    return this.dispatch(req, res);
  }

  @Get('wagering/transactions/:transactionId')
  @ApiParam({ name: 'transactionId', format: 'uuid' })
  @ApiResponse({ status: 200, schema: apiSchema(responses.transaction) })
  transaction(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    return this.dispatch(req, res);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiParam({ name: 'providerId', type: String })
  @ApiParam({ name: 'externalTransactionId', type: String })
  @ApiResponse({ status: 200, schema: apiSchema(responses.transaction) })
  providerTransaction(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    return this.dispatch(req, res);
  }

  @Get('health/live')
  @ApiTags('Operations')
  @ApiResponse({ status: 200, schema: apiSchema(responses.live) })
  live(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    return this.dispatch(req, res);
  }

  @Get(['health', 'health/ready'])
  @ApiTags('Operations')
  @ApiResponse({ status: 200, schema: apiSchema(responses.ready) })
  @ApiResponse({ status: 503, schema: apiSchema(responses.ready) })
  ready(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    return this.dispatch(req, res);
  }

  @Get('metrics')
  @ApiTags('Operations')
  @ApiResponse({ status: 200, content: { 'text/plain': { schema: { type: 'string' } } } })
  metrics(@Req() req: HttpRequest, @Res() res: HttpResponse): Promise<void> {
    return this.dispatch(req, res);
  }
}
