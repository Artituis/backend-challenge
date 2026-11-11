import type { WagerResponse } from '../wagering/contracts';

/** Only committed outcomes are reported; telemetry never participates in financial decisions. */
export interface WagerObserver {
  committed(result: WagerResponse, context: { walletId: string; providerId: string; correlationId?: string; messageId?: string }): void;
  retry(): void;
}
export const silentObserver: WagerObserver = { committed() {}, retry() {} };
