import { Migration } from '@mikro-orm/migrations';

export class Migration202611110004 extends Migration {
  override async up(): Promise<void> {
    this
      .addSql(`CREATE INDEX outbox_pending_trace_idx ON outbox_messages ((payload->>'transactionId'))
      WHERE event_type = 'WagerTransactionPendingReference'`);
  }
  override async down(): Promise<void> {
    this.addSql('DROP INDEX outbox_pending_trace_idx');
  }
}
