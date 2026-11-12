import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

import { persistenceEntities } from './entities';
import { Migration202611100001 } from './migrations/Migration202611100001';
import { Migration202611100002 } from './migrations/Migration202611100002';
import { Migration202611100003 } from './migrations/Migration202611100003';
import { Migration202611110004 } from './migrations/Migration202611110004';

export function persistenceConfig(clientUrl = process.env['DATABASE_URL']) {
  if (!clientUrl) throw new Error('DATABASE_URL is required');
  return defineConfig({
    clientUrl,
    entities: persistenceEntities,
    extensions: [Migrator],
    allowGlobalContext: false,
    implicitTransactions: false,
    debug: false,
    logger: () => undefined, // SQL/parameters and connection errors must never reach stdout.
    pool: { min: 0, max: 10 },
    migrations: {
      migrationsList: [
        Migration202611100001,
        Migration202611100002,
        Migration202611100003,
        Migration202611110004,
      ],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      disableForeignKeys: false,
    },
  });
}
