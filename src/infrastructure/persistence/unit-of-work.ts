import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../application/ports/persistence';
import { MikroInboxRepository, MikroOutboxRepository, MikroWagerTransactionRepository,
  MikroWalletLedgerRepository, MikroWalletRepository, TransactionScope } from './repositories';

export class MikroUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}
  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    // Each invocation owns its connection/identity map; no global EntityManager state.
    return this.orm.em.fork({ clear: true, useContext: false }).transactional(async em => {
      const scope = new TransactionScope(em);
      try {
        return await work({ wallets: new MikroWalletRepository(scope),
          transactions: new MikroWagerTransactionRepository(scope), ledger: new MikroWalletLedgerRepository(scope),
          inbox: new MikroInboxRepository(scope), outbox: new MikroOutboxRepository(scope) });
      } finally { scope.close(); }
    }, { isolationLevel: IsolationLevel.READ_COMMITTED });
  }
}
