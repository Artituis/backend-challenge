import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import type { UnitOfWork } from '../../application/ports/persistence';
import { UNIT_OF_WORK } from '../../application/ports/persistence';
import { ProcessWager } from '../../application/wagering/process-wager';
import { HealthModule, HealthService } from '../health/health.module';
import { LoggingModule } from '../observability/logging.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { WageringModule } from '../wagering.module';
import { Api } from './api';
import { ApiController } from './controller';
import type { ProviderIdentityPort } from './identity';
import { NoopProviderIdentity, PROVIDER_IDENTITY } from './identity';
import { HttpServer } from './server';

function port(key: string, fallback: number): number {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Invalid HTTP port');
  return value;
}
export class HttpModule {}
Module({
  imports: [WageringModule, PersistenceModule, HealthModule, LoggingModule],
  controllers: [ApiController],
  providers: [
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
    {
      provide: Api,
      inject: [MikroORM, UNIT_OF_WORK, ProcessWager, PROVIDER_IDENTITY],
      useFactory: (
        orm: MikroORM,
        uow: UnitOfWork,
        processor: ProcessWager,
        identity: ProviderIdentityPort,
      ) => new Api(orm, uow, processor, identity),
    },
  ],
})(HttpModule);

export class WorkerOperationsModule {}
Module({
  imports: [HealthModule],
  providers: [
    {
      provide: HttpServer,
      inject: [HealthService],
      useFactory: (health: HealthService) =>
        new HttpServer(health, undefined, port('WORKER_HEALTH_PORT', 3001)),
    },
  ],
})(WorkerOperationsModule);
