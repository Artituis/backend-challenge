import type { CreateWagerTransactionProps, OpenWalletProps } from '../../src/domain';
import { Money, WagerTransaction, WagerTransactionKind, Wallet } from '../../src/domain';

export const at = () => new Date('2026-01-01T00:00:00.000Z');
export const later = () => new Date('2026-01-01T00:01:00.000Z');
export const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
export const movement = (transactionId = 'bet-1') => ({
  transactionId,
  ledgerEntryId: `ledger-${transactionId}`,
  at: later(),
});
export function wallet(overrides: Partial<OpenWalletProps> = {}): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: money('100.00'),
    at: at(),
    opening: { ledgerEntryId: 'ledger-opening', transactionId: 'opening-1' },
    ...overrides,
  });
}
export function transactionProps(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-1',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-1:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: money('25.00'),
    createdAt: at(),
    ...overrides,
  };
}
export function transaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create(transactionProps(overrides));
}
export function processedBet(): WagerTransaction {
  const bet = transaction();
  bet.markProcessed(undefined, at());
  return bet;
}
