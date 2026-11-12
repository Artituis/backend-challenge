import { MikroORM } from '@mikro-orm/postgresql';

import { persistenceConfig } from './mikro-orm.config';

const command = process.argv[2] ?? 'up';
if (!['up', 'down', 'pending'].includes(command))
  throw new Error('Usage: migrate.ts [up|down|pending]');
const orm = await MikroORM.init(persistenceConfig());
try {
  const migrator = orm.getMigrator();
  if (command === 'up') await migrator.up();
  else if (command === 'down') await migrator.down();
  else console.log(await migrator.getPendingMigrations());
} finally {
  await orm.close(true);
}
