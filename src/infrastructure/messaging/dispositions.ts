import type { MikroORM } from '@mikro-orm/postgresql';
import type { Delivery } from './sqs';
import { hash } from './sqs';

export type Disposition = 'TERMINAL' | 'DEAD_LETTER' | 'QUARANTINED';
export interface DispositionRecord { disposition: Disposition; reason: string; }
export interface DispositionStore {
  find(queue: string, message: Delivery): Promise<DispositionRecord | undefined>;
  save(queue: string, message: Delivery, disposition: Disposition, reason: string): Promise<void>;
}

/** Transport failures cannot always create a valid wager. Persist their outcome before ack. */
export class MikroDispositionStore implements DispositionStore {
  constructor(private readonly orm: MikroORM) {}
  async find(queue: string, message: Delivery): Promise<DispositionRecord | undefined> {
    const rows = await this.orm.em.fork().execute<DispositionRecord[]>(`
      select disposition, reason from message_dispositions where source_queue = ? and message_id = ? and payload_hash = ?`,
    [queue, message.id, hash(message.body)]);
    return rows[0];
  }
  async save(queue: string, message: Delivery, disposition: Disposition, reason: string): Promise<void> {
    await this.orm.em.fork().transactional(async em => {
      await em.execute("set local statement_timeout = '15s'");
      await em.execute(`insert into message_dispositions(source_queue, message_id, payload_hash, body, disposition, reason)
        values (?, ?, ?, ?, ?, ?) on conflict do nothing`,
      [queue, message.id, hash(message.body), message.body, disposition, reason]);
    });
  }
}
