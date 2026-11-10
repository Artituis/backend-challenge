import { Migration } from '@mikro-orm/migrations';

export class Migration202611100003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_failure_code_check;
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_failure_code_check CHECK
        (failure_code IN ('INVALID_MONEY','CURRENCY_MISMATCH','INVALID_PAYLOAD','INSUFFICIENT_FUNDS',
          'REVERSAL_INSUFFICIENT_FUNDS','INVALID_STATE','INVALID_REFERENCE','REFERENCE_NOT_FOUND',
          'REFERENCE_EXPIRED','ALREADY_REVERSED','IDEMPOTENCY_CONFLICT','INVALID_LEDGER','PERMANENT_INFRASTRUCTURE_FAILURE'));
      CREATE TABLE pending_reference_jobs (
        transaction_id text PRIMARY KEY REFERENCES wager_transactions(id),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz(3) NOT NULL
      );
      CREATE INDEX pending_reference_jobs_due_idx ON pending_reference_jobs(next_attempt_at, transaction_id);
      CREATE FUNCTION schedule_pending_reference() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'PENDING_REFERENCE' THEN
          INSERT INTO pending_reference_jobs(transaction_id, next_attempt_at) VALUES (NEW.id, NEW.created_at)
            ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER schedule_pending_reference AFTER INSERT OR UPDATE OF status ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION schedule_pending_reference();
      INSERT INTO pending_reference_jobs(transaction_id, next_attempt_at)
        SELECT id, created_at FROM wager_transactions WHERE status = 'PENDING_REFERENCE';
      CREATE TABLE message_dispositions (
        source_queue text NOT NULL,
        message_id text NOT NULL,
        payload_hash text NOT NULL,
        body text NOT NULL,
        disposition text NOT NULL CHECK (disposition IN ('TERMINAL','DEAD_LETTER','QUARANTINED')),
        reason text NOT NULL,
        received_at timestamptz(3) NOT NULL DEFAULT now(),
        PRIMARY KEY(source_queue, message_id, payload_hash)
      );
    `);
  }
  override async down(): Promise<void> {
    // Refuse rollback if the old domain cannot represent committed expiration results.
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_failure_code_check;
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_failure_code_check CHECK
        (failure_code IN ('INVALID_MONEY','CURRENCY_MISMATCH','INVALID_PAYLOAD','INSUFFICIENT_FUNDS',
          'REVERSAL_INSUFFICIENT_FUNDS','INVALID_STATE','INVALID_REFERENCE','REFERENCE_NOT_FOUND',
          'ALREADY_REVERSED','IDEMPOTENCY_CONFLICT','INVALID_LEDGER','PERMANENT_INFRASTRUCTURE_FAILURE'));
      DROP TABLE message_dispositions;
      DROP TRIGGER schedule_pending_reference ON wager_transactions;
      DROP FUNCTION schedule_pending_reference();
      DROP TABLE pending_reference_jobs;
    `);
  }
}
