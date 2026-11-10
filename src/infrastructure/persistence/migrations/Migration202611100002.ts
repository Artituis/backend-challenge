import { Migration } from '@mikro-orm/migrations';

/** Immutable submission response, including the balance observed under the wallet lock. */
export class Migration202611100002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wager_results (
        transaction_id text PRIMARY KEY REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
        CHECK ((result->>'transactionId') IS NOT DISTINCT FROM transaction_id),
        CHECK (result ?& ARRAY['status', 'balance', 'walletVersion', 'failureCode']),
        CHECK (result->>'status' IN ('PROCESSED', 'REJECTED', 'FAILED', 'PENDING_REFERENCE'))
      );
      CREATE TRIGGER wager_results_immutable BEFORE UPDATE OR DELETE ON wager_results
        FOR EACH ROW EXECUTE FUNCTION wagering_forbid_mutation();
      CREATE TRIGGER wager_results_no_truncate BEFORE TRUNCATE ON wager_results
        FOR EACH STATEMENT EXECUTE FUNCTION wagering_forbid_mutation();
    `);
  }
  override async down(): Promise<void> { this.addSql('DROP TABLE wager_results;'); }
}
