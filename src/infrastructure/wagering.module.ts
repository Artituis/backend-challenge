import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { UNIT_OF_WORK } from '../application/ports/persistence';
import type { UnitOfWork } from '../application/ports/persistence';
import { APPLICATION_RUNTIME } from '../application/wagering/contracts';
import type { ApplicationRuntime } from '../application/wagering/contracts';
import { ProcessWager } from '../application/wagering/process-wager';
import { BetUseCase, WinUseCase, LossUseCase, RefundUseCase, RollbackUseCase } from '../application/wagering/use-cases';
import { PersistenceModule } from './persistence/persistence.module';
import { SystemRuntime } from './system-runtime';
import { wagerObserver } from './observability/telemetry';

const useCases = [BetUseCase, WinUseCase, LossUseCase, RefundUseCase, RollbackUseCase];
export class WageringModule {}
Module({
  imports: [PersistenceModule],
  providers: [
    { provide: APPLICATION_RUNTIME, useClass: SystemRuntime },
    { provide: ProcessWager, inject: [UNIT_OF_WORK, APPLICATION_RUNTIME],
      useFactory: (uow: UnitOfWork, runtime: ApplicationRuntime) => new ProcessWager(uow, runtime, wagerObserver) },
    ...useCases.map(useCase => ({ provide: useCase, inject: [ProcessWager],
      useFactory: (processor: ProcessWager) => new useCase(processor) })),
  ],
  exports: [ProcessWager, ...useCases],
})(WageringModule);
