import type { MikroORM } from '@mikro-orm/postgresql';

/** Exact PostgreSQL numeric arithmetic: includes OPENING, never converts money to JS number. */
export async function assertLedgerInvariant(orm: MikroORM): Promise<void> {
  const broken = await orm.em.fork().execute<{ id: string; balance: string; reconstructed: string }[]>(`
    select w.id, w.balance::text, coalesce(sum(case when l.direction = 'CREDIT'
      then l.amount else -l.amount end), 0)::text as reconstructed
    from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
    group by w.id having w.balance <> coalesce(sum(case when l.direction = 'CREDIT'
      then l.amount else -l.amount end), 0)`);
  if (broken.length) throw new Error(`Ledger invariant violated: ${JSON.stringify(broken)}`);
}
