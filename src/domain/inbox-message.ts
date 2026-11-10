import { FailureCode, invariant } from './errors';
import { date, dateAfter, identifier } from './validation';

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}
export interface InboxMessageState extends ReceiveInboxProps { readonly processedAt?: Date; }

export class InboxMessage {
  readonly #props: ReceiveInboxProps;
  #processedAt: Date | undefined;
  private constructor(state: InboxMessageState) {
    for (const field of ['messageId', 'consumerName', 'payloadHash'] as const) identifier(state[field], field);
    this.#props = Object.freeze({ ...state, receivedAt: date(state.receivedAt) });
    this.#processedAt = state.processedAt === undefined ? undefined : dateAfter(state.processedAt, state.receivedAt);
    Object.freeze(this);
  }
  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage({ messageId: props.messageId, consumerName: props.consumerName, payloadHash: props.payloadHash, receivedAt: props.receivedAt });
  }
  static rehydrate(state: InboxMessageState): InboxMessage { return new InboxMessage(state); }
  get messageId(): string { return this.#props.messageId; }
  get consumerName(): string { return this.#props.consumerName; }
  get payloadHash(): string { return this.#props.payloadHash; }
  get receivedAt(): Date { return date(this.#props.receivedAt); }
  get processedAt(): Date | undefined { return this.#processedAt === undefined ? undefined : date(this.#processedAt); }
  isProcessed(): boolean { return this.#processedAt !== undefined; }
  assertSameDelivery(props: Pick<ReceiveInboxProps, 'messageId' | 'consumerName' | 'payloadHash'>): void {
    invariant(props.messageId === this.messageId && props.consumerName === this.consumerName && props.payloadHash === this.payloadHash,
      FailureCode.IdempotencyConflict, 'Message identity or payload differs');
  }
  markProcessed(at: Date): void {
    invariant(!this.isProcessed(), FailureCode.InvalidState, 'Inbox message already processed');
    this.#processedAt = dateAfter(at, this.#props.receivedAt);
  }
}
