import 'reflect-metadata';

import { MikroORM } from '@mikro-orm/postgresql';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Module } from '@nestjs/common';

import { UNIT_OF_WORK } from '../../application/ports/persistence';
import { persistenceConfig } from './mikro-orm.config';
import { MikroUnitOfWork } from './unit-of-work';

class PersistenceShutdown implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

/** Explicit factory injection also works on Bun without decorator metadata emission. */
export class PersistenceModule {}
Module({
  providers: [
    { provide: MikroORM, useFactory: () => MikroORM.init(persistenceConfig()) },
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroUnitOfWork(orm),
    },
    {
      provide: PersistenceShutdown,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new PersistenceShutdown(orm),
    },
  ],
  exports: [UNIT_OF_WORK, MikroORM],
})(PersistenceModule);
