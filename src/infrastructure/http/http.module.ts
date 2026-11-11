import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK } from '../../application/ports/persistence';
import type { UnitOfWork } from '../../application/ports/persistence';
import { ProcessWager } from '../../application/wagering/process-wager';
import { WageringModule } from '../wagering.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { HealthModule, HealthService } from '../health/health.module';
import { Api } from './api';
import { HttpServer } from './server';
import { NoopProviderIdentity, PROVIDER_IDENTITY } from './identity';
import type { ProviderIdentityPort } from './identity';

function port(key: string, fallback: number): number {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Invalid HTTP port');
  return value;
}
export class HttpModule {}
Module({
  imports: [WageringModule, PersistenceModule, HealthModule],
  providers: [
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
    { provide: Api, inject: [MikroORM, UNIT_OF_WORK, ProcessWager, PROVIDER_IDENTITY],
      useFactory: (orm: MikroORM, uow: UnitOfWork, processor: ProcessWager, identity: ProviderIdentityPort) => new Api(orm, uow, processor, identity) },
    { provide: HttpServer, inject: [HealthService, Api],
      useFactory: (health: HealthService, api: Api) => new HttpServer(health, api, port('PORT', 3000)) },
  ],
})(HttpModule);

export class WorkerOperationsModule {}
Module({ imports: [HealthModule], providers: [
  { provide: HttpServer, inject: [HealthService],
    useFactory: (health: HealthService) => new HttpServer(health, undefined, port('WORKER_HEALTH_PORT', 3001)) },
] })(WorkerOperationsModule);
