import { createHash } from 'node:crypto';

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import type { OutboxMessage } from '../../domain';
import type { MessagingConfig } from './config';

export interface Delivery {
  id: string;
  receipt: string;
  body: string;
  group: string;
  receives: number;
}
export interface QueueTransport {
  receive(queue: string, signal: AbortSignal): Promise<Delivery | undefined>;
  ack(queue: string, message: Delivery): Promise<void>;
  visibility(queue: string, message: Delivery, seconds: number): Promise<void>;
  deadLetter(message: Delivery, reason: string): Promise<void>;
  publish(message: OutboxMessage): Promise<void>;
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export class SqsMessaging implements QueueTransport {
  private readonly urls = new Map<string, string>();
  readonly client: SQSClient;
  constructor(private readonly config: MessagingConfig) {
    this.client = new SQSClient({
      region: config.region,
      maxAttempts: 1,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    });
  }
  async initialize(): Promise<void> {
    for (const name of [this.config.queueName, this.config.dlqName, this.config.eventsQueueName]) {
      const result = await this.client.send(
        new GetQueueUrlCommand({ QueueName: name }),
        this.timeout(),
      );
      if (!result.QueueUrl) throw new Error(`Missing queue URL: ${name}`);
      this.urls.set(name, result.QueueUrl);
    }
  }
  private url(name: string): string {
    const url = this.urls.get(name);
    if (!url) throw new Error(`Queue not initialized: ${name}`);
    return url;
  }
  /** Active, non-destructive check of every required queue; URL cache is never a health signal. */
  async probe(signal: AbortSignal): Promise<void> {
    await Promise.all(
      [this.config.queueName, this.config.dlqName, this.config.eventsQueueName].map(
        async (name) => {
          const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: name }), {
            abortSignal: signal,
          });
          if (!QueueUrl) throw new Error('Queue unavailable');
          await this.client.send(
            new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
            { abortSignal: signal },
          );
        },
      ),
    );
  }
  private timeout(): { abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) };
  }
  async receive(queue: string, signal: AbortSignal): Promise<Delivery | undefined> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.url(queue),
        // One at a time per receiver preserves FIFO even when a message needs retry.
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.config.pollSeconds,
        VisibilityTimeout: this.config.visibilitySeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      {
        abortSignal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.config.pollSeconds * 1000 + this.config.requestTimeoutMs),
        ]),
      },
    );
    const message = result.Messages?.[0];
    if (!message) return undefined;
    if (!message.MessageId || !message.ReceiptHandle || message.Body === undefined)
      throw new Error('Incomplete SQS delivery');
    return {
      id: message.MessageId,
      receipt: message.ReceiptHandle,
      body: message.Body,
      group: message.Attributes?.['MessageGroupId'] ?? message.MessageId,
      receives: Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1'),
    };
  }
  async ack(queue: string, message: Delivery): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.url(queue), ReceiptHandle: message.receipt }),
      this.timeout(),
    );
  }
  async visibility(queue: string, message: Delivery, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.url(queue),
        ReceiptHandle: message.receipt,
        VisibilityTimeout: seconds,
      }),
      this.timeout(),
    );
  }
  async deadLetter(message: Delivery, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.url(this.config.dlqName),
        MessageBody: message.body,
        MessageGroupId: message.group,
        MessageDeduplicationId: hash(`${message.id}:${hash(message.body)}`),
        MessageAttributes: {
          originalMessageId: { DataType: 'String', StringValue: message.id },
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 256) },
        },
      }),
      this.timeout(),
    );
  }
  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.url(this.config.eventsQueueName),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: hash(message.aggregateId),
        MessageDeduplicationId: hash(message.id),
      }),
      this.timeout(),
    );
  }
  close(): void {
    this.client.destroy();
  }
}
