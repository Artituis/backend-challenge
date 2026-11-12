import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import type { Repositories, UnitOfWork } from '../../src/application/ports/persistence';
import { UNIT_OF_WORK } from '../../src/application/ports/persistence';
import {
  FailureCode,
  InboxMessage,
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  Wallet,
} from '../../src/domain';
import { persistenceConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { PersistenceModule } from '../../src/infrastructure/persistence/persistence.module';
import { MikroUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { assertLedgerInvariant } from '../support/invariant';

const url = process.env['TEST_DATABASE_URL'];
const suite = url ? describe : describe.skip;
const at = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-01T00:01:00.000Z');
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const id = () => crypto.randomUUID();

suite('PostgreSQL persistence (real migrations, no schema generator)', () => {
  let orm: MikroORM;
  let admin: MikroORM;
  let uow: MikroUnitOfWork;
  const schema = `persistence_test_${id().replaceAll('-', '')}`;

  afterEach(async () => {
    if (orm) await assertLedgerInvariant(orm);
  });

  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('TEST_DATABASE_URL must target a database ending in _test');
    admin = await MikroORM.init(persistenceConfig(url));
    await admin.em.getConnection().execute(`create schema ${schema}`);
    orm = await MikroORM.init({
      ...persistenceConfig(url),
      schema,
      driverOptions: { connection: { options: `-c search_path=${schema}` } },
    });
    await orm.getMigrator().up();
    expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(4);
    await orm.getMigrator().down({ to: 0 });
    expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(0);
    const tables = await orm.em
      .getConnection()
      .execute<{ tablename: string }[]>(
        'select tablename from pg_tables where schemaname = ? and tablename <> ?',
        [schema, 'mikro_orm_migrations'],
      );
    expect(tables).toEqual([]);
    await orm.getMigrator().up();
    uow = new MikroUnitOfWork(orm);
  }, 30_000);

  afterAll(async () => {
    if (orm) await orm.close(true);
    if (admin) {
      await admin.em.getConnection().execute(`drop schema if exists ${schema} cascade`);
      await admin.close(true);
    }
  });

  async function open(balance = '100.00'): Promise<Wallet> {
    const walletId = id();
    const openingId = id();
    const wallet = Wallet.open({
      id: walletId,
      playerId: id(),
      initialBalance: money(balance),
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
          payloadHash: 'opening-hash',
          walletId,
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
  function transaction(
    wallet: Wallet,
    kind = WagerTransactionKind.Bet,
    amount = '25.00',
    overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
  ): WagerTransaction {
    const txId = id();
    return WagerTransaction.create({
      id: txId,
      providerId: 'provider',
      externalTransactionId: txId,
      idempotencyKey: txId,
      payloadHash: 'hash',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind,
      money: money(amount),
      createdAt: at,
      ...overrides,
    });
  }
  async function apply(r: Repositories, walletId: string, tx: WagerTransaction): Promise<void> {
    const wallet = await r.wallets.findById(walletId);
    if (!wallet) throw new Error('Wallet missing');
    wallet.debit(tx.money, { ledgerEntryId: id(), transactionId: tx.id, at: later });
    tx.markProcessed(undefined, later);
    r.transactions.add(tx);
    r.wallets.save(wallet);
  }
  async function sql(statement: string, params: unknown[] = []): Promise<unknown> {
    return orm.em.fork().transactional((em) => em.execute(statement, params));
  }

  test('migrations can go up/down/up and leave no pending migration', async () => {
    expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
  });

  test('round trips exact large money, opening, counters and immutable ledger without replay', async () => {
    const original = await open('9007199254740993123456789.12');
    await uow.run(async (r) => {
      const loaded = await r.wallets.findById(original.id);
      expect(loaded?.balance.amount).toBe(original.balance.amount);
      expect(loaded?.version).toBe(1);
      expect(loaded?.ledgerEntries).toHaveLength(0);
      expect(await r.wallets.findByPlayer(original.playerId, 'BRL')).toBe(loaded);
      const entries = await r.ledger.listByWallet(original.id, 0, 10);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.balanceBefore.amount).toBe('0.00');
      expect(entries[0]?.balanceAfter.amount).toBe(original.balance.amount);
    });
  });

  test('commits wallet, wager, ledger, inbox and outbox atomically', async () => {
    const wallet = await open();
    const tx = transaction(wallet);
    const messageId = id();
    const eventId = id();
    await uow.run(async (r) => {
      await apply(r, wallet.id, tx);
      const inbox = InboxMessage.receive({
        messageId,
        consumerName: 'consumer',
        payloadHash: 'hash',
        receivedAt: at,
      });
      inbox.markProcessed(later);
      r.inbox.add(inbox);
      r.outbox.add(
        OutboxMessage.enqueue({
          id: eventId,
          aggregateId: wallet.id,
          eventType: 'WalletBalanceChanged',
          payload: { amount: '75.00', currency: 'BRL' },
          occurredAt: later,
        }),
      );
    });
    await uow.run(async (r) => {
      expect((await r.wallets.findById(wallet.id))?.balance.amount).toBe('75.00');
      expect((await r.wallets.findById(wallet.id))?.version).toBe(2);
      expect(
        (await r.transactions.findByIdempotencyKey('provider', tx.idempotencyKey))?.processedAt,
      ).toEqual(later);
      expect(
        (await r.transactions.findByExternalId('provider', tx.externalTransactionId))?.id,
      ).toBe(tx.id);
      expect((await r.ledger.findByTransaction(wallet.id, tx.id))?.balanceAfter.amount).toBe(
        '75.00',
      );
      expect((await r.inbox.find('consumer', messageId))?.isProcessed()).toBe(true);
      expect((await r.outbox.findById(eventId))?.payload).toEqual({
        amount: '75.00',
        currency: 'BRL',
      });
    });
  });

  test('late constraint failure rolls back all five repositories', async () => {
    const wallet = await open();
    const tx = transaction(wallet);
    const eventId = id();
    const messageId = id();
    await expect(
      uow.run(async (r) => {
        await apply(r, wallet.id, tx);
        r.inbox.add(
          InboxMessage.receive({
            messageId,
            consumerName: 'rollback',
            payloadHash: 'hash',
            receivedAt: at,
          }),
        );
        r.outbox.add(
          OutboxMessage.enqueue({
            id: eventId,
            aggregateId: wallet.id,
            eventType: 'changed',
            payload: {},
            occurredAt: at,
          }),
        );
        const orphan = transaction(wallet);
        orphan.markProcessed(undefined, later);
        r.transactions.add(orphan);
      }),
    ).rejects.toThrow();
    await uow.run(async (r) => {
      expect((await r.wallets.findById(wallet.id))?.balance.amount).toBe('100.00');
      expect(await r.transactions.findById(tx.id)).toBeUndefined();
      expect(await r.ledger.findByTransaction(wallet.id, tx.id)).toBeUndefined();
      expect(await r.inbox.find('rollback', messageId)).toBeUndefined();
      expect(await r.outbox.findById(eventId)).toBeUndefined();
    });
  });

  test('zero opening needs no ledger; LOSS and rejection do not change the version', async () => {
    const wallet = await open('0.00');
    const loss = transaction(wallet, WagerTransactionKind.Loss, '0.00');
    const rejected = transaction(wallet);
    rejected.reject(FailureCode.InsufficientFunds);
    loss.markProcessed(undefined, later);
    await uow.run(async (r) => {
      r.transactions.add(loss);
      r.transactions.add(rejected);
    });
    await uow.run(async (r) => {
      expect((await r.wallets.findById(wallet.id))?.version).toBe(1);
      expect(await r.ledger.listByWallet(wallet.id, 0, 10)).toHaveLength(0);
      expect((await r.transactions.findById(rejected.id))?.failureCode).toBe(
        FailureCode.InsufficientFunds,
      );
    });
  });

  test('persists multiple movements and repeated save without duplicating ledger', async () => {
    const wallet = await open();
    await uow.run(async (r) => {
      await apply(r, wallet.id, transaction(wallet));
      await apply(r, wallet.id, transaction(wallet));
      const loaded = await r.wallets.findById(wallet.id);
      if (loaded) r.wallets.save(loaded);
    });
    await uow.run(async (r) => {
      expect((await r.wallets.findById(wallet.id))?.version).toBe(3);
      expect(await r.ledger.listByWallet(wallet.id, 0, 10)).toHaveLength(3);
    });
  });

  test('two concurrent debits cannot overspend or lose updates', async () => {
    const wallet = await open();
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        uow.run((r) => apply(r, wallet.id, transaction(wallet, WagerTransactionKind.Bet, '80.00'))),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await uow.run(async (r) => {
      expect((await r.wallets.findById(wallet.id))?.balance.amount).toBe('20.00');
      expect(await r.ledger.listByWallet(wallet.id, 0, 10)).toHaveLength(2);
    });
  });

  test('unique keys arbitrate concurrent inserts, scoped by provider and consumer', async () => {
    const wallet = await open();
    const key = id();
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        uow.run(async (r) => {
          r.transactions.add(
            transaction(wallet, WagerTransactionKind.Bet, '25.00', { idempotencyKey: key }),
          );
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(
      uow.run(async (r) => {
        r.wallets.add(
          Wallet.open({ id: id(), playerId: wallet.playerId, initialBalance: money('0.00'), at }),
        );
      }),
    ).rejects.toThrow();
    const messageId = id();
    await uow.run(async (r) => {
      r.inbox.add(
        InboxMessage.receive({ messageId, consumerName: 'a', payloadHash: 'hash', receivedAt: at }),
      );
    });
    await expect(
      uow.run(async (r) => {
        r.inbox.add(
          InboxMessage.receive({
            messageId,
            consumerName: 'a',
            payloadHash: 'other',
            receivedAt: at,
          }),
        );
      }),
    ).rejects.toThrow();
    await uow.run(async (r) => {
      r.inbox.add(
        InboxMessage.receive({ messageId, consumerName: 'b', payloadHash: 'hash', receivedAt: at }),
      );
    });
  });

  test('database rejects negative balance, fractional cents, overflow, special numerics and wallet-only changes', async () => {
    const wallet = await open();
    for (const value of [
      '-1.00',
      '1.001',
      '1.000',
      '1e36',
      'NaN',
      'Infinity',
      '-Infinity',
      '99.00',
    ]) {
      await expect(
        sql('update wallets set balance = ?::numeric, version = version + 1 where id = ?', [
          value,
          wallet.id,
        ]),
      ).rejects.toThrow();
    }
    await expect(
      sql('update wallets set version = version + 1 where id = ?', [wallet.id]),
    ).rejects.toThrow();
    await expect(
      sql('update wallets set currency = ? where id = ?', ['USD', wallet.id]),
    ).rejects.toThrow();
  });

  test('SQL reports the exact uniqueness and nonnegative-balance constraints', async () => {
    const wallet = await open();
    await expect(
      sql(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
      values (?, ?, 'BRL', 0, 1, ?, ?)`,
        [id(), wallet.playerId, at, at],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'wallets_player_currency_unique' });
    await expect(
      sql('update wallets set balance = -1, version = version + 1 where id = ?', [wallet.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'wallets_balance_check' });
    await uow.run(async (r) => {
      r.wallets.add(
        Wallet.open({
          id: id(),
          playerId: wallet.playerId,
          initialBalance: Money.from({ amount: '0.00', currency: 'USD' }),
          at,
        }),
      );
    });
  });

  test('database prevents ledger mutation and terminal wager mutation', async () => {
    const wallet = await open();
    await expect(
      sql('update wallet_ledger_entries set amount = amount where wallet_id = ?', [wallet.id]),
    ).rejects.toThrow();
    await expect(
      sql('delete from wallet_ledger_entries where wallet_id = ?', [wallet.id]),
    ).rejects.toThrow();
    await expect(sql('truncate wallet_ledger_entries')).rejects.toThrow();
    await expect(
      sql(
        "update wager_transactions set status = 'PENDING', processed_at = null where wallet_id = ?",
        [wallet.id],
      ),
    ).rejects.toThrow();
    await expect(
      sql('delete from wager_transactions where wallet_id = ?', [wallet.id]),
    ).rejects.toThrow();
  });

  test('external transaction uniqueness is provider-scoped and payload cannot be rewritten', async () => {
    const wallet = await open('0.00');
    const original = transaction(wallet);
    await uow.run(async (r) => {
      r.transactions.add(original);
    });
    await expect(
      uow.run(async (r) => {
        r.transactions.add(
          transaction(wallet, WagerTransactionKind.Bet, '25.00', {
            externalTransactionId: original.externalTransactionId,
          }),
        );
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'wagers_provider_external_unique' },
    });
    await uow.run(async (r) => {
      r.transactions.add(
        transaction(wallet, WagerTransactionKind.Bet, '25.00', {
          providerId: 'another-provider',
          externalTransactionId: original.externalTransactionId,
          idempotencyKey: original.idempotencyKey,
        }),
      );
    });
    await expect(
      sql('update wager_transactions set payload_hash = ? where id = ?', ['changed', original.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('deferred database checks reject partial reversals even when bypassing domain factories', async () => {
    const wallet = await open();
    const bet = transaction(wallet);
    await uow.run((r) => apply(r, wallet.id, bet));
    const refund = transaction(wallet, WagerTransactionKind.Refund, '10.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await uow.run(async (r) => {
      r.transactions.add(refund);
    });
    await expect(
      orm.em.fork().transactional(async (em) => {
        await em.execute(
          "update wager_transactions set status = 'PROCESSED', processed_at = ?, reference_transaction_id = ? where id = ?",
          [later, bet.id, refund.id],
        );
        await em.execute(
          'update wallets set balance = balance + 10, version = version + 1, updated_at = ? where id = ?',
          [later, wallet.id],
        );
        await em.execute(
          `insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
        values (?, ?, ?, 3, 'CREDIT', 10, 'BRL', 75, 85, ?)`,
          [id(), wallet.id, refund.id, later],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('database prevents wrong wallet/currency associations and inconsistent ledger chains', async () => {
    const wallet = await open();
    const mismatch = transaction(wallet, WagerTransactionKind.Bet, '25.00', {
      money: Money.from({ amount: '25.00', currency: 'USD' }),
    });
    await expect(
      uow.run(async (r) => {
        r.transactions.add(mismatch);
      }),
    ).rejects.toMatchObject({ code: '23503' });
    const tx = transaction(wallet);
    await uow.run(async (r) => {
      r.transactions.add(tx);
    });
    await expect(
      orm.em.fork().transactional(async (em) => {
        await em.execute(
          "update wager_transactions set status = 'PROCESSED', processed_at = ? where id = ?",
          [later, tx.id],
        );
        await em.execute(
          'update wallets set balance = 65, version = 2, updated_at = ? where id = ?',
          [later, wallet.id],
        );
        // Locally balanced, but begins at 90 instead of the previous entry's 100.
        await em.execute(
          `insert into wallet_ledger_entries
        (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at)
        values (?, ?, ?, 2, 'DEBIT', 25, 'BRL', 90, 65, ?)`,
          [id(), wallet.id, tx.id, later],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('pending reference is rehydrated, then resolved; second refund is rejected by unique index', async () => {
    const wallet = await open();
    const bet = transaction(wallet);
    await uow.run((r) => apply(r, wallet.id, bet));
    const refund = transaction(wallet, WagerTransactionKind.Refund, '25.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    refund.markPendingReference();
    await uow.run(async (r) => {
      r.transactions.add(refund);
    });
    await uow.run(async (r) => {
      const pending = (
        await r.transactions.findPendingReferences('provider', bet.externalTransactionId, 10)
      )[0];
      const reference = await r.transactions.findById(bet.id);
      const loaded = await r.wallets.findById(wallet.id);
      if (!pending || !reference || !loaded) throw new Error('Missing refund state');
      pending.markProcessed(reference, later);
      loaded.credit(pending.money, { ledgerEntryId: id(), transactionId: pending.id, at: later });
      r.transactions.save(pending);
      r.wallets.save(loaded);
    });
    await expect(
      uow.run(async (r) => {
        const reference = await r.transactions.findById(bet.id);
        const loaded = await r.wallets.findById(wallet.id);
        if (!loaded || !reference) throw new Error('Missing state');
        const duplicate = transaction(wallet, WagerTransactionKind.Refund, '25.00', {
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        duplicate.markProcessed(reference, later);
        loaded.credit(duplicate.money, {
          ledgerEntryId: id(),
          transactionId: duplicate.id,
          at: later,
        });
        r.transactions.add(duplicate);
        r.wallets.save(loaded);
      }),
    ).rejects.toThrow();
  });

  test('outbox claims skip locked rows and rollback releases a claim', async () => {
    const eventId = id();
    await uow.run(async (r) => {
      r.outbox.add(
        OutboxMessage.enqueue({
          id: eventId,
          aggregateId: id(),
          eventType: 'claim',
          payload: {},
          occurredAt: at,
        }),
      );
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = uow.run(async (r) => {
      await r.outbox.findDue(later, 1000);
      locked();
      await released;
      throw new Error('publisher crash');
    });
    // Attach a rejection handler immediately; do not start a Bun async assertion
    // before releasing the transaction it is supposed to wait for.
    const outcome = first.catch((error: unknown) => error);
    try {
      await Promise.race([isLocked, first]);
      await uow.run(async (r) => {
        expect(await r.outbox.findDue(later, 1000)).toHaveLength(0);
      });
    } finally {
      release();
    }
    expect(await outcome).toEqual(new Error('publisher crash'));
    await uow.run(async (r) => {
      const due = await r.outbox.findDue(later, 1000);
      const event = due.find((message) => message.id === eventId);
      expect(event).toBeDefined();
      if (event) {
        event.scheduleRetry(later);
        r.outbox.save(event);
      }
    });
    await uow.run(async (r) => {
      const event = await r.outbox.findById(eventId);
      expect(event?.attempts).toBe(1);
      expect(event?.isDue(later)).toBe(false);
      if (event) {
        event.markPublished(new Date(later.getTime() + 1000));
        r.outbox.save(event);
      }
    });
    await uow.run(async (r) => {
      expect((await r.outbox.findById(eventId))?.isPending()).toBe(false);
    });
  });

  test('inbox pending lookup and terminal update, outbox future scheduling and immutable payload', async () => {
    const messageId = id();
    const consumerName = id();
    const eventId = id();
    await uow.run(async (r) => {
      r.inbox.add(
        InboxMessage.receive({ messageId, consumerName, payloadHash: 'hash', receivedAt: at }),
      );
      r.outbox.add(
        OutboxMessage.enqueue({
          id: eventId,
          aggregateId: id(),
          eventType: 'future',
          payload: {},
          occurredAt: new Date('2030-01-01'),
        }),
      );
    });
    await uow.run(async (r) => {
      const inbox = (await r.inbox.findPending(consumerName, 10))[0];
      if (!inbox) throw new Error('Missing inbox message');
      inbox.markProcessed(later);
      r.inbox.save(inbox);
      expect((await r.outbox.findDue(later, 1000)).some((event) => event.id === eventId)).toBe(
        false,
      );
    });
    await expect(
      sql(
        'update inbox_messages set processed_at = null where consumer_name = ? and message_id = ?',
        [consumerName, messageId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql('update outbox_messages set payload = ?::jsonb where id = ?', [
        '{"changed":true}',
        eventId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('repositories reject detached aggregates and use outside the callback', async () => {
    const wallet = await open();
    await expect(
      uow.run(async (r) => {
        r.wallets.save(wallet);
      }),
    ).rejects.toThrow('Load the aggregate');
    const repositories = await uow.run(async (r) => r);
    await expect(repositories.wallets.findById(wallet.id)).rejects.toThrow('active UnitOfWork');
  });

  test('add never merges a duplicate primary key already present in the identity map', async () => {
    const wallet = await open('0.00');
    const tx = transaction(wallet);
    await uow.run(async (r) => {
      r.transactions.add(tx);
    });
    await expect(
      uow.run(async (r) => {
        await r.transactions.findById(tx.id);
        r.transactions.add(
          transaction(wallet, WagerTransactionKind.Bet, '25.00', {
            id: tx.id,
            externalTransactionId: tx.externalTransactionId,
            idempotencyKey: tx.idempotencyKey,
          }),
        );
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  test('Nest module exposes UnitOfWork and closes the ORM on shutdown', async () => {
    const previous = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = url;
    try {
      const app = await NestFactory.createApplicationContext(PersistenceModule, {
        logger: false,
        abortOnError: false,
      });
      expect(app.get<UnitOfWork>(UNIT_OF_WORK)).toBeInstanceOf(MikroUnitOfWork);
      await app.close();
    } finally {
      if (previous === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = previous;
    }
  });
});
