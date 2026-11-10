import { WagerTransactionKind } from '../../domain';
import type { WagerCommand, WagerKind, WagerResponse } from './contracts';
import type { ProcessWager } from './process-wager';

export type OperationCommand = Omit<WagerCommand, 'kind'>;
abstract class WagerUseCase {
  protected abstract readonly kind: WagerKind;
  constructor(private readonly processor: ProcessWager) {}
  execute(command: OperationCommand): Promise<WagerResponse> {
    return this.processor.execute({ ...command, kind: this.kind });
  }
}
export class BetUseCase extends WagerUseCase { protected readonly kind = WagerTransactionKind.Bet; }
export class WinUseCase extends WagerUseCase { protected readonly kind = WagerTransactionKind.Win; }
export class LossUseCase extends WagerUseCase { protected readonly kind = WagerTransactionKind.Loss; }
export class RefundUseCase extends WagerUseCase { protected readonly kind = WagerTransactionKind.Refund; }
export class RollbackUseCase extends WagerUseCase { protected readonly kind = WagerTransactionKind.Rollback; }
