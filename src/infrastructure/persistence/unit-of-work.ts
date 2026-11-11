import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../application/ports/persistence';
import { RetryableTransactionError } from '../../application/wagering/contracts';
import { logger, metrics } from '../observability/telemetry';
import { MikroInboxRepository, MikroOutboxRepository, MikroWagerTransactionRepository,
  MikroWalletLedgerRepository, MikroWalletRepository, MikroIdentityLocks, MikroWagerResultRepository, MikroPendingReferences, TransactionScope } from './repositories';

function retryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  const constraint = 'constraint' in error ? error.constraint : undefined;
  return code === '40001' || code === '40P01' || code === '55P03'
    || (code === '23505' && typeof constraint === 'string' && [
      'wagers_provider_external_unique', 'wagers_provider_idempotency_unique',
      'inbox_messages_pkey', 'wagers_processed_reversal_unique',
    ].includes(constraint));
}

export class MikroUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}
  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    // Each invocation owns its connection/identity map; no global EntityManager state.
    try {
      return await this.orm.em.fork({ clear: true, useContext: false }).transactional(async em => {
        await em.execute("set local lock_timeout = '5s'");
        await em.execute("set local statement_timeout = '15s'");
        const scope = new TransactionScope(em);
        try {
          return await work({ pendingReferences: new MikroPendingReferences(scope), identities: new MikroIdentityLocks(scope), results: new MikroWagerResultRepository(scope),
            wallets: new MikroWalletRepository(scope),
            transactions: new MikroWagerTransactionRepository(scope), ledger: new MikroWalletLedgerRepository(scope),
            inbox: new MikroInboxRepository(scope), outbox: new MikroOutboxRepository(scope) });
        } finally { scope.close(); }
      }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    } catch (error) {
      // transactional() has already rolled back, including flush/deferred-commit failures.
      if (retryable(error)) {
        if (error instanceof Error && 'code' in error && error.code === '23505') metrics.increment('idempotency_retries');
        else { metrics.increment('lock_conflicts'); logger.event('lock_conflict', {}, 'warn'); }
        throw new RetryableTransactionError(error);
      }
      throw error;
    }
  }
}
