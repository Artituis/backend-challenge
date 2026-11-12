import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ZodError } from 'zod';

import type { UnitOfWork } from '../../application/ports/persistence';
import type { ProcessWager } from '../../application/wagering/process-wager';
import {
  DomainError,
  FailureCode,
  Money,
  WagerTransaction,
  WagerTransactionStatus,
  Wallet,
} from '../../domain';
import { decodeWager, InvalidEnvelopeError } from '../messaging/decode';
import { bindTrace, logger, metrics, trace } from '../observability/telemetry';
import { WagerTransactionRow, WalletLedgerRow, WalletRow } from '../persistence/entities';
import { walletMapper } from '../persistence/mappers';
import {
  createWalletSchema,
  emptyBodySchema,
  identifierSchema,
  ledgerCursorSchema,
  ledgerQuerySchema,
  submitTransactionSchema,
  transactionHeadersSchema,
  uuidSchema,
} from '../validation/contracts';
import type { ProviderIdentityPort } from './identity';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export class Api {
  constructor(
    private readonly orm: MikroORM,
    private readonly uow: UnitOfWork,
    private readonly processor: ProcessWager,
    private readonly identity: ProviderIdentityPort,
  ) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = request.method;
    const walletId = parts[0] === 'wallets' ? parts[1] : undefined;
    if (walletId) bindTrace({ walletId: uuidSchema.parse(walletId) });
    await this.identity.authorize(request, walletId ? { walletId } : {});

    if (method === 'POST' && url.pathname === '/wallets') {
      const input = createWalletSchema.parse(await request.json());
      const money = Money.from(input.initialBalance);
      const at = new Date();
      const openingId = crypto.randomUUID();
      const wallet = Wallet.open({
        id: crypto.randomUUID(),
        playerId: input['playerId'],
        initialBalance: money,
        at,
        opening: { transactionId: openingId, ledgerEntryId: crypto.randomUUID() },
      });
      await this.uow.run((r) => {
        if (money.isPositive()) {
          const opening = WagerTransaction.createOpening({
            id: openingId,
            providerId: 'internal',
            externalTransactionId: openingId,
            idempotencyKey: openingId,
            payloadHash: 'opening',
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening',
            gameId: 'internal',
            money,
            createdAt: at,
          });
          opening.markProcessed(undefined, at);
          r.transactions.add(opening);
        }
        r.wallets.add(wallet);
        return Promise.resolve();
      });
      bindTrace({
        walletId: wallet.id,
        ...(money.isPositive() ? { transactionId: openingId, providerId: 'internal' } : {}),
      });
      return Response.json(
        {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        },
        { status: 201 },
      );
    }
    if (method === 'POST' && url.pathname === '/wagering/transactions') {
      const input = submitTransactionSchema.parse(await request.json());
      const key = transactionHeadersSchema.parse(Object.fromEntries(request.headers))[
        'idempotency-key'
      ];
      const { delivery: _delivery, ...command } = decodeWager(
        JSON.stringify({ ...input, idempotencyKey: key, correlationId: trace().correlationId }),
        'http',
        crypto.randomUUID(),
      );
      bindTrace({ walletId: command.walletId, providerId: command.providerId });
      await this.identity.authorize(request, {
        providerId: command.providerId,
        walletId: command.walletId,
      });
      const result = await this.processor.execute(command);
      bindTrace({ transactionId: result.transactionId });
      const status =
        result.status === WagerTransactionStatus.PendingReference
          ? 202
          : result.status === WagerTransactionStatus.Rejected
            ? 422
            : result.status === WagerTransactionStatus.Failed
              ? 500
              : 200;
      return Response.json(result, { status });
    }
    if (walletId && parts.length === 2 && method === 'GET') {
      const row = await this.orm.em.fork().findOne(WalletRow, { id: walletId });
      if (!row) throw new ApiError(404, 'NOT_FOUND');
      return Response.json({
        id: row.id,
        playerId: row.playerId,
        balance: { amount: row.balance, currency: row.currency },
        version: row.version,
      });
    }
    if (walletId && parts.length === 3 && parts[2] === 'ledger' && method === 'GET') {
      if ([...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length > 1))
        throw new ApiError(400, 'INVALID_PAYLOAD');
      const query = ledgerQuerySchema.parse(Object.fromEntries(url.searchParams));
      const limit = query.limit ?? 50;
      let after = 0;
      const cursor = query.cursor;
      if (cursor) {
        try {
          const decoded = ledgerCursorSchema.parse(
            JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
          );
          if (decoded['walletId'] !== walletId) throw new Error();
          after = decoded['version'];
        } catch {
          throw new ApiError(400, 'INVALID_PAYLOAD');
        }
      }
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new ApiError(400, 'INVALID_PAYLOAD');
      const em = this.orm.em.fork();
      if (!(await em.findOne(WalletRow, { id: walletId }))) throw new ApiError(404, 'NOT_FOUND');
      const rows = await em.find(
        WalletLedgerRow,
        { walletId, walletVersion: { $gt: after } },
        { orderBy: { walletVersion: 'asc' }, limit: limit + 1 },
      );
      const page = rows.slice(0, limit);
      return Response.json({
        entries: page.map((row) => ({
          id: row.id,
          transactionId: row.transactionId,
          walletId,
          walletVersion: row.walletVersion,
          direction: row.direction,
          money: { amount: row.amount, currency: row.currency },
          balanceBefore: { amount: row.balanceBefore, currency: row.currency },
          balanceAfter: { amount: row.balanceAfter, currency: row.currency },
          createdAt: row.createdAt,
        })),
        nextCursor:
          rows.length > limit
            ? Buffer.from(
                JSON.stringify({ walletId, version: page.at(-1)!.walletVersion }),
              ).toString('base64url')
            : null,
      });
    }
    if (walletId && parts.length === 3 && parts[2] === 'reconciliation' && method === 'POST') {
      const body = await request.text();
      emptyBodySchema.parse(body ? JSON.parse(body) : {});
      const result = await this.orm.em.fork().transactional(async (em) => {
        await em.execute("set local lock_timeout = '5s'");
        await em.execute("set local statement_timeout = '15s'");
        const row = await em.findOne(
          WalletRow,
          { id: walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!row) throw new ApiError(404, 'NOT_FOUND');
        const wallet = walletMapper.toDomain(row);
        // Same connection and wallet lock: a concurrent debit cannot create a false mismatch.
        const rows = await em.execute<{ balance: string; count: string }[]>(
          `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as balance,
            count(*)::text as count from wallet_ledger_entries where wallet_id = ?`,
          [walletId],
        );
        const calculated = Money.from({ amount: rows[0]!.balance, currency: wallet.currency });
        return {
          walletId,
          storedBalance: wallet.balance.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: wallet.balance.subtract(calculated).toJSON(),
          consistent: wallet.balance.equals(calculated),
          checkedEntries: rows[0]!.count,
        };
      });
      if (!result.consistent) {
        metrics.increment('reconciliation_mismatches');
        logger.event('reconciliation_mismatch', {}, 'error');
      }
      return Response.json(result);
    }
    let where: { id: string } | { providerId: string; externalTransactionId: string } | undefined;
    if (
      method === 'GET' &&
      parts.length === 3 &&
      parts[0] === 'wagering' &&
      parts[1] === 'transactions'
    )
      where = { id: uuidSchema.parse(parts[2]) };
    if (
      method === 'GET' &&
      parts.length === 5 &&
      parts[0] === 'providers' &&
      parts[2] === 'wagering' &&
      parts[3] === 'transactions'
    ) {
      where = {
        providerId: identifierSchema.parse(parts[1]),
        externalTransactionId: identifierSchema.parse(parts[4]),
      };
    }
    if (where) {
      const tx = await this.orm.em.fork().findOne(WagerTransactionRow, where);
      if (!tx) throw new ApiError(404, 'NOT_FOUND');
      await this.identity.authorize(request, { providerId: tx.providerId, walletId: tx.walletId });
      bindTrace({ transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId });
      return Response.json({
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode,
        money: { amount: tx.amount, currency: tx.currency },
        createdAt: tx.createdAt,
        processedAt: tx.processedAt,
      });
    }
    throw new ApiError(404, 'NOT_FOUND');
  }
}

export function httpError(error: unknown): { status: number; code: string } {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) return { status: 400, code: 'INVALID_PAYLOAD' };
  if (error instanceof SyntaxError || error instanceof URIError)
    return { status: 400, code: 'INVALID_PAYLOAD' };
  if (error instanceof DomainError) {
    const status =
      error.code === FailureCode.IdempotencyConflict
        ? 409
        : [FailureCode.InvalidPayload, FailureCode.InvalidMoney].includes(error.code)
          ? 400
          : [
                FailureCode.InvalidState,
                FailureCode.InvalidLedger,
                FailureCode.PermanentInfrastructureFailure,
              ].includes(error.code)
            ? 500
            : 422;
    return { status, code: error.code };
  }
  if (error instanceof InvalidEnvelopeError) return { status: 400, code: 'INVALID_PAYLOAD' };
  if (
    error instanceof Error &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'wallets_player_currency_unique'
  )
    return { status: 409, code: 'WALLET_ALREADY_EXISTS' };
  return { status: 503, code: 'INFRASTRUCTURE_UNAVAILABLE' };
}
