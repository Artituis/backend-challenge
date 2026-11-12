import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import type { UnitOfWork } from '../../src/application/ports/persistence';
import type { WagerCommand, WagerKind } from '../../src/application/wagering/contracts';
import { ProcessWager } from '../../src/application/wagering/process-wager';
import {
  BetUseCase,
  LossUseCase,
  RefundUseCase,
  RollbackUseCase,
  WinUseCase,
} from '../../src/application/wagering/use-cases';
import {
  FailureCode,
  Money,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  Wallet,
} from '../../src/domain';
import { LedgerDirection } from '../../src/domain';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { SystemRuntime } from '../../src/infrastructure/system-runtime';
import { assertLedgerInvariant } from '../support/invariant';

const url = process.env['TEST_DATABASE_URL'];
const suite = url ? describe : describe.skip;
const id = () => crypto.randomUUID();
const at = new Date('2026-01-01T00:00:00Z');
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });

suite('Wagering application with three independent ORM pools', () => {
  let admin: MikroORM;
  let orm: MikroORM;
  const instances: MikroORM[] = [];
  let uow: MikroUnitOfWork;
  let processor: ProcessWager;
  const processors: ProcessWager[] = [];
  const schema = `wagering_test_${id().replaceAll('-', '')}`;

  afterEach(async () => {
    if (orm) await assertLedgerInvariant(orm);
  });

  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('Requires a database ending in _test');
    admin = await MikroORM.init(persistenceConfig(url));
    await admin.em.getConnection().execute(`create schema ${schema}`);
    for (let i = 0; i < 3; i += 1) {
      const instance = await MikroORM.init({
        ...persistenceConfig(url),
        schema,
        driverOptions: { connection: { options: `-c search_path=${schema}` } },
      });
      instances.push(instance);
      processors.push(new ProcessWager(new MikroUnitOfWork(instance), new SystemRuntime()));
    }
    orm = instances[0]!;
    processor = processors[0]!;
    uow = new MikroUnitOfWork(orm);
    await orm.getMigrator().up();
    await orm.getMigrator().down({ to: 0 });
    await orm.getMigrator().up();
  }, 30_000);

  afterAll(async () => {
    await Promise.all(instances.map((instance) => instance.close(true)));
    if (admin) {
      await admin.em.getConnection().execute(`drop schema if exists ${schema} cascade`);
      await admin.close(true);
    }
  });

  async function open(amount = '100.00'): Promise<Wallet> {
    const openingId = id();
    const wallet = Wallet.open({
      id: id(),
      playerId: id(),
      initialBalance: money(amount),
      at,
      opening: { transactionId: openingId, ledgerEntryId: id() },
    });
    await uow.run(async (r) => {
      if (wallet.balance.isPositive()) {
        const tx = WagerTransaction.createOpening({
          id: openingId,
          providerId: 'internal',
          externalTransactionId: openingId,
          idempotencyKey: openingId,
          payloadHash: 'opening',
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'opening',
          gameId: 'internal',
          money: wallet.balance,
          createdAt: at,
        });
        tx.markProcessed(undefined, at);
        r.transactions.add(tx);
      }
      r.wallets.add(wallet);
    });
    return wallet;
  }

  function command(
    wallet: Wallet,
    kind: WagerKind = Kind.Bet,
    amount = '25.00',
    overrides: Partial<WagerCommand> = {},
  ): WagerCommand {
    const externalId = id();
    return {
      providerId: 'provider',
      externalTransactionId: externalId,
      idempotencyKey: externalId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind,
      money: { amount, currency: 'BRL' },
      ...overrides,
    };
  }
  async function counts(
    wallet: Wallet,
  ): Promise<{ wagers: number; ledger: number; results: number; outbox: number }> {
    const rows = await orm.em
      .fork()
      .execute<{ wagers: number; ledger: number; results: number; outbox: number }[]>(
        `
      select (select count(*)::int from wager_transactions where wallet_id = ? and kind <> 'OPENING') as wagers,
        (select count(*)::int from wallet_ledger_entries where wallet_id = ?) as ledger,
        (select count(*)::int from wager_results r join wager_transactions t on t.id = r.transaction_id where t.wallet_id = ?) as results,
        (select count(*)::int from outbox_messages where aggregate_id = ?) as outbox`,
        [wallet.id, wallet.id, wallet.id, wallet.id],
      );
    return rows[0]!;
  }

  test('two simultaneous 80 BRL bets: one processed, one rejected, retries never debit again', async () => {
    const wallet = await open();
    const inputs = [command(wallet, Kind.Bet, '80.00'), command(wallet, Kind.Bet, '80.00')];
    const responses = await Promise.all(inputs.map((input, i) => processors[i]!.execute(input)));
    expect(responses.filter((r) => r.status === Status.Processed)).toHaveLength(1);
    expect(
      responses.filter(
        (r) => r.status === Status.Rejected && r.failureCode === FailureCode.InsufficientFunds,
      ),
    ).toHaveLength(1);
    for (let i = 0; i < inputs.length; i++) {
      expect(await processors[2]!.execute(inputs[i]!)).toEqual({
        ...responses[i]!,
        idempotentReplay: true,
      });
    }
    await uow.run(async (r) => {
      expect((await r.wallets.findById(wallet.id))?.balance.amount).toBe('20.00');
      const ledger = await r.ledger.listByWallet(wallet.id, 0, 100);
      expect(ledger.filter((entry) => entry.direction === LedgerDirection.Debit)).toHaveLength(1);
      expect(ledger).toHaveLength(2); // One opening credit plus exactly one bet debit.
    });
    expect(await counts(wallet)).toEqual({ wagers: 2, ledger: 2, results: 2, outbox: 3 });
  });

  test('50 simultaneous copies return one original and 49 identical persisted replays', async () => {
    const wallet = await open();
    const input = command(wallet);
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => processors[i % 3]!.execute(input)),
    );
    const originals = responses.filter((r) => !r.idempotentReplay);
    expect(originals).toHaveLength(1);
    expect(responses.filter((r) => r.idempotentReplay)).toHaveLength(49);
    for (const response of responses.filter((r) => r.idempotentReplay)) {
      expect(response).toEqual({ ...originals[0]!, idempotentReplay: true });
    }
    expect(originals[0]?.balance.amount).toBe('75.00');
    expect(await counts(wallet)).toEqual({ wagers: 1, ledger: 2, results: 1, outbox: 2 });
  }, 30_000);

  test('20 distinct wallets process five concurrent debits each without lost updates', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => open()));
    const responses = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, (_, i) =>
          processors[i % 3]!.execute(command(wallet, Kind.Bet, '10.00')),
        ),
      ),
    );
    expect(responses.every((r) => r.status === Status.Processed)).toBe(true);
    for (const wallet of wallets) {
      await uow.run(async (r) =>
        expect((await r.wallets.findById(wallet.id))?.balance.amount).toBe('50.00'),
      );
      expect(await counts(wallet)).toEqual({ wagers: 5, ledger: 6, results: 5, outbox: 10 });
    }
  }, 30_000);

  test('three competing BETs cannot overspend; rejection and LOSS do not increment version', async () => {
    const wallet = await open();
    const outcomes = await Promise.all(
      processors.map((p) => p.execute(command(wallet, Kind.Bet, '60.00'))),
    );
    expect(outcomes.filter((r) => r.status === Status.Processed)).toHaveLength(1);
    expect(outcomes.filter((r) => r.failureCode === FailureCode.InsufficientFunds)).toHaveLength(2);
    expect(outcomes.every((r) => r.balance.amount === '40.00' && r.walletVersion === 2)).toBe(true);
    const loss = await new LossUseCase(processor).execute(command(wallet, Kind.Loss, '0.00'));
    expect(loss.status).toBe(Status.Processed);
    expect(loss.walletVersion).toBe(2);
    expect(await counts(wallet)).toEqual({ wagers: 4, ledger: 2, results: 4, outbox: 5 });
  });

  test('30 concurrent credits from three instances preserve every increment and ledger link', async () => {
    const wallet = await open('0.00');
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        processors[i % 3]!.execute(command(wallet, Kind.Win, '0.01')),
      ),
    );
    await uow.run(async (r) => {
      const loaded = await r.wallets.findById(wallet.id);
      expect(loaded?.balance.amount).toBe('0.30');
      expect(loaded?.version).toBe(31);
      const ledger = await r.ledger.listByWallet(wallet.id, 0, 100);
      expect(ledger).toHaveLength(30);
      ledger.forEach((entry, index) =>
        expect(entry.balanceBefore.amount).toBe(
          index === 0 ? '0.00' : ledger[index - 1]!.balanceAfter.amount,
        ),
      );
    });
  }, 30_000);

  test('concurrent normalized replays across HTTP/SQS persist one effect and the original balance', async () => {
    const wallet = await open();
    const input = command(wallet);
    const delivery = { consumerName: 'wagering', messageId: id() };
    const responses = await Promise.all(
      processors.map((p, i) =>
        p.execute({
          ...input,
          money: { amount: i === 0 ? '025.0' : '25.00', currency: 'BRL' },
          ...(i === 0 ? {} : { delivery }),
        }),
      ),
    );
    expect(responses.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.transactionId)).size).toBe(1);
    await new WinUseCase(processor).execute(command(wallet, Kind.Win, '500.00'));
    const replay = await processor.execute(input);
    expect(replay).toEqual({ ...responses[0]!, idempotentReplay: true });
    expect(replay.balance.amount).toBe('75.00');
    await uow.run(async (r) =>
      expect((await r.inbox.find(delivery.consumerName, delivery.messageId))?.isProcessed()).toBe(
        true,
      ),
    );
    expect(await counts(wallet)).toEqual({ wagers: 2, ledger: 3, results: 2, outbox: 4 });
  });

  test('concurrent altered payload/key/external identity conflicts, including different wallets', async () => {
    const wallet = await open();
    const other = await open();
    const input = command(wallet);
    const outcomes = await Promise.allSettled([
      processors[0]!.execute(input),
      processors[1]!.execute({ ...input, money: { amount: '26.00', currency: 'BRL' } }),
      processors[2]!.execute({ ...input, walletId: other.id, playerId: other.playerId }),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        expect(outcome.reason).toMatchObject({ code: FailureCode.IdempotencyConflict });
    await expect(processor.execute({ ...input, idempotencyKey: id() })).rejects.toMatchObject({
      code: FailureCode.IdempotencyConflict,
    });
    await expect(
      processor.execute({ ...input, externalTransactionId: id() }),
    ).rejects.toMatchObject({ code: FailureCode.IdempotencyConflict });
  });

  test('a reused SQS message ID cannot hide a changed key or business payload', async () => {
    const wallet = await open();
    const input = command(wallet, Kind.Bet, '25.00', {
      delivery: { consumerName: 'consumer', messageId: id() },
    });
    await processor.execute(input);
    await expect(processor.execute({ ...input, idempotencyKey: id() })).rejects.toMatchObject({
      code: FailureCode.IdempotencyConflict,
    });
    await expect(processor.execute({ ...input, gameId: 'changed' })).rejects.toMatchObject({
      code: FailureCode.IdempotencyConflict,
    });
    expect(await counts(wallet)).toEqual({ wagers: 1, ledger: 2, results: 1, outbox: 2 });
  });

  test('rejection remains an original replay after a deposit', async () => {
    const wallet = await open('0.00');
    const input = command(wallet);
    const rejected = await new BetUseCase(processor).execute(input);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    await processor.execute(command(wallet, Kind.Win, '100.00'));
    expect(await processor.execute(input)).toEqual({ ...rejected, idempotentReplay: true });
    expect(rejected.walletVersion).toBe(1);
    expect(await counts(wallet)).toEqual({ wagers: 2, ledger: 1, results: 2, outbox: 3 });
  });

  test('concurrent REFUNDs allow one reversal of a BET and persist ALREADY_REVERSED', async () => {
    const wallet = await open();
    const bet = command(wallet);
    await processor.execute(bet);
    const outcomes = await Promise.all(
      processors.map((p) =>
        new RefundUseCase(p).execute(
          command(wallet, Kind.Refund, '25.00', {
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        ),
      ),
    );
    expect(outcomes.filter((r) => r.status === Status.Processed)).toHaveLength(1);
    expect(outcomes.filter((r) => r.failureCode === FailureCode.AlreadyReversed)).toHaveLength(2);
    expect(outcomes.every((r) => r.balance.amount === '100.00' && r.walletVersion === 3)).toBe(
      true,
    );
  });

  test('ROLLBACK inverts BET, WIN and REFUND; insufficient reversal funds has a dedicated code', async () => {
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund] as const) {
      const wallet = await open();
      const bet = command(wallet);
      await processor.execute(bet);
      const reference =
        kind === Kind.Bet
          ? bet
          : command(
              wallet,
              kind,
              '25.00',
              kind === Kind.Refund
                ? { referenceExternalTransactionId: bet.externalTransactionId }
                : {},
            );
      if (kind !== Kind.Bet) await processor.execute(reference);
      const rollback = await new RollbackUseCase(processor).execute(
        command(wallet, Kind.Rollback, '25.00', {
          referenceExternalTransactionId: reference.externalTransactionId,
        }),
      );
      expect(rollback.balance.amount).toBe(kind === Kind.Bet ? '100.00' : '75.00');
      expect(rollback.status).toBe(Status.Processed);
    }
    const wallet = await open('0.00');
    const win = command(wallet, Kind.Win, '25.00');
    await processor.execute(win);
    await processor.execute(command(wallet));
    const rejected = await processor.execute(
      command(wallet, Kind.Rollback, '25.00', {
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(rejected.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rejected.walletVersion).toBe(3);
    expect(rejected.balance.amount).toBe('0.00');
  });

  test('references enforce wallet, player, round, amount, currency, type and processed status', async () => {
    const wallet = await open();
    const other = await open();
    const bet = command(wallet);
    await processor.execute(bet);
    const invalid: WagerCommand[] = [
      command(other, Kind.Refund, '25.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      command(wallet, Kind.Refund, '25.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
        roundId: 'different',
      }),
      command(wallet, Kind.Refund, '24.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    ];
    const win = command(wallet, Kind.Win);
    await processor.execute(win);
    invalid.push(
      command(wallet, Kind.Refund, '25.00', {
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    const rejectedBet = command(wallet, Kind.Bet, '999.00');
    await processor.execute(rejectedBet);
    invalid.push(
      command(wallet, Kind.Rollback, '999.00', {
        referenceExternalTransactionId: rejectedBet.externalTransactionId,
      }),
    );
    for (const input of invalid)
      expect((await processor.execute(input)).failureCode).toBe(FailureCode.InvalidReference);
    await expect(
      processor.execute(command(wallet, Kind.Win, '25.00', { playerId: other.playerId })),
    ).rejects.toMatchObject({ code: FailureCode.InvalidPayload });
    await expect(
      processor.execute(
        command(wallet, Kind.Win, '25.00', { money: { amount: '25.00', currency: 'USD' } }),
      ),
    ).rejects.toMatchObject({ code: FailureCode.CurrencyMismatch });
  });

  test('WIN/LOSS validate optional BET references and wrong providers remain pending', async () => {
    const wallet = await open();
    const bet = command(wallet);
    await processor.execute(bet);
    expect(
      (
        await processor.execute(
          command(wallet, Kind.Win, '3.00', {
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        )
      ).status,
    ).toBe(Status.Processed);
    const loss = await processor.execute(
      command(wallet, Kind.Loss, '0.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
        roundId: 'different',
      }),
    );
    expect(loss.failureCode).toBe(FailureCode.InvalidReference);
    const pending = await processor.execute(
      command(wallet, Kind.Refund, '25.00', {
        providerId: 'another-provider',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(pending.status).toBe(Status.PendingReference);
  });

  test('missing reference persists pending wager, stable acceptance, inbox and one outbox event', async () => {
    const wallet = await open();
    const bet = command(wallet);
    const input = command(wallet, Kind.Refund, '25.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
      delivery: { consumerName: 'consumer', messageId: id() },
    });
    const pending = await processor.execute(input);
    expect(pending.status).toBe(Status.PendingReference);
    expect(pending.walletVersion).toBe(1);
    expect(await counts(wallet)).toEqual({ wagers: 1, ledger: 1, results: 1, outbox: 1 });
    await processor.execute(bet);
    // Submission replay does not double as a worker retry or change the original response.
    expect(await processor.execute(input)).toEqual({ ...pending, idempotentReplay: true });
    await uow.run(async (r) =>
      expect(
        (await r.transactions.findByExternalId(input.providerId, input.externalTransactionId))
          ?.status,
      ).toBe(Status.PendingReference),
    );
  });

  test('deferred commit failure rolls back wallet, wager, ledger, result, inbox and outbox', async () => {
    const wallet = await open();
    const input = command(wallet, Kind.Bet, '25.00', {
      delivery: { consumerName: 'atomic', messageId: id() },
    });
    const failing: UnitOfWork = {
      run: (work) =>
        uow.run(async (r) => {
          const result = await work(r);
          const orphan = WagerTransaction.create({
            ...command(wallet),
            money: money('25.00'),
            id: id(),
            payloadHash: 'fault-injection',
            createdAt: at,
          });
          orphan.markProcessed(undefined, at);
          r.transactions.add(orphan); // Missing ledger fails only at deferred constraint/COMMIT.
          return result;
        }),
    };
    await expect(new ProcessWager(failing, new SystemRuntime()).execute(input)).rejects.toThrow();
    expect(await counts(wallet)).toEqual({ wagers: 0, ledger: 1, results: 0, outbox: 0 });
    await uow.run(async (r) => {
      expect((await r.wallets.findById(wallet.id))?.balance.amount).toBe('100.00');
      expect((await r.wallets.findById(wallet.id))?.version).toBe(1);
      expect(await r.inbox.find('atomic', input.delivery!.messageId)).toBeUndefined();
    });
    expect((await processor.execute(input)).idempotentReplay).toBe(false);
  });

  test('outbox failure aborts the financial operation and does not consume the delivery/key', async () => {
    const wallet = await open();
    const input = command(wallet, Kind.Bet, '25.00', {
      delivery: { consumerName: 'outbox-fault', messageId: id() },
    });
    await orm.em.getConnection()
      .execute(`create function fail_outbox_insert() returns trigger language plpgsql as $$
      begin raise exception 'outbox unavailable' using errcode = '23514'; end $$;
      create trigger fail_outbox_insert before insert on outbox_messages for each row execute function fail_outbox_insert()`);
    try {
      await expect(processor.execute(input)).rejects.toThrow('outbox unavailable');
    } finally {
      await orm.em
        .getConnection()
        .execute(
          'drop trigger fail_outbox_insert on outbox_messages; drop function fail_outbox_insert()',
        );
    }
    expect(await counts(wallet)).toEqual({ wagers: 0, ledger: 1, results: 0, outbox: 0 });
    expect((await processor.execute(input)).idempotentReplay).toBe(false);
  });

  test('original response is immutable in SQL', async () => {
    const wallet = await open();
    const result = await processor.execute(command(wallet));
    await expect(
      orm.em
        .fork()
        .execute('update wager_results set result = result where transaction_id = ?', [
          result.transactionId,
        ]),
    ).rejects.toThrow('Financial history');
  });

  test('retry rebuilds all aggregates after rollback; only one set of effects commits', async () => {
    const wallet = await open();
    const delays: number[] = [];
    const runtime = new SystemRuntime();
    runtime.pause = async (milliseconds) => {
      delays.push(milliseconds);
    };
    runtime.random = () => 0;
    // Sequences survive rollback: both errors originate inside PostgreSQL, through the real driver.
    await orm.em.getConnection().execute(`create sequence qa_retry_attempts;
      create function qa_retry_insert() returns trigger language plpgsql as $$ begin
        if nextval('qa_retry_attempts') < 3 then
          raise exception 'injected serialization failure' using errcode = '40001';
        end if;
        return NEW;
      end $$;
      create trigger qa_retry_insert before insert on wager_transactions for each row execute function qa_retry_insert()`);
    const input = command(wallet, Kind.Bet, '25.00', {
      delivery: { consumerName: 'retry', messageId: id() },
    });
    try {
      const response = await new ProcessWager(uow, runtime).execute(input);
      const attempts = await orm.em
        .fork()
        .execute<{ attempts: number }[]>(
          'select last_value::int as attempts from qa_retry_attempts',
        );
      expect(attempts[0]?.attempts).toBe(3);
      expect(delays).toEqual([25, 50]);
      expect(response.balance.amount).toBe('75.00');
      expect(response.walletVersion).toBe(2);
      expect(await counts(wallet)).toEqual({ wagers: 1, ledger: 2, results: 1, outbox: 2 });
      expect(await processor.execute(input)).toEqual({ ...response, idempotentReplay: true });
    } finally {
      await orm.em
        .getConnection()
        .execute(
          'drop trigger qa_retry_insert on wager_transactions; drop function qa_retry_insert(); drop sequence qa_retry_attempts',
        );
    }
  });

  test('a locked hot wallet does not block an unrelated wallet', async () => {
    const hot = await open();
    const independent = await open();
    let acquired!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = uow.run(async (r) => {
      await r.wallets.findById(hot.id);
      acquired();
      await gate;
    });
    await ready;
    const waiting = processors[1]!.execute(command(hot));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        processors[2]!.execute(command(independent)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Unrelated wallet blocked')), 3_000);
        }),
      ]);
      expect(completed.balance.amount).toBe('75.00');
    } finally {
      clearTimeout(timeout);
      release();
      await holding;
      await waiting;
    }
  });

  test('concurrent reuse of a delivery across wallets is arbitrated before either wallet is changed', async () => {
    const wallets = await Promise.all([open(), open(), open()]);
    const delivery = { consumerName: 'delivery-race', messageId: id() };
    const outcomes = await Promise.allSettled(
      processors.map((p, i) => p.execute(command(wallets[i]!, Kind.Bet, '25.00', { delivery }))),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        expect(outcome.reason).toMatchObject({ code: FailureCode.IdempotencyConflict });
    const totals = await Promise.all(wallets.map(counts));
    expect(totals.reduce((sum, count) => sum + count.wagers, 0)).toBe(1);
    expect(totals.reduce((sum, count) => sum + count.outbox, 0)).toBe(2);
  });

  test('clock skew between instances does not break wallet/ledger timestamp consistency', async () => {
    const wallet = await open();
    const ahead = new SystemRuntime();
    ahead.now = () => new Date('2030-01-01T00:00:00Z');
    const behind = new SystemRuntime();
    behind.now = () => new Date('2020-01-01T00:00:00Z');
    await new ProcessWager(uow, ahead).execute(command(wallet));
    const result = await new ProcessWager(new MikroUnitOfWork(instances[1]!), behind).execute(
      command(wallet),
    );
    expect(result.balance.amount).toBe('50.00');
    expect(result.walletVersion).toBe(3);
    await uow.run(async (r) => {
      expect((await r.wallets.findById(wallet.id))?.updatedAt.toISOString()).toBe(
        '2030-01-01T00:00:00.000Z',
      );
      expect(
        (await r.transactions.findById(result.transactionId))?.processedAt?.toISOString(),
      ).toBe('2030-01-01T00:00:00.000Z');
    });
  });
});
