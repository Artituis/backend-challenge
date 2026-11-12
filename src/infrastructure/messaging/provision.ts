import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import type { MessagingConfig } from './config';
import { messagingConfig } from './config';

/** Local provisioning only; production queues and IAM belong in deployment infrastructure. */
export async function provisionQueues(client: SQSClient, config: MessagingConfig): Promise<void> {
  const create = async (name: string): Promise<string> => {
    const result = await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    if (!result.QueueUrl) throw new Error(`Cannot create queue ${name}`);
    return result.QueueUrl;
  };
  const dlq = await create(config.dlqName);
  const attributes = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
  );
  const arn = attributes.Attributes?.['QueueArn'];
  if (!arn) throw new Error('DLQ ARN missing');
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: dlq,
      Attributes: { MessageRetentionPeriod: '1209600' },
    }),
  );
  const queue = await create(config.queueName);
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: queue,
      Attributes: {
        VisibilityTimeout: String(config.visibilitySeconds),
        ReceiveMessageWaitTimeSeconds: String(config.pollSeconds),
        MessageRetentionPeriod: '345600',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: arn,
          maxReceiveCount: config.maxReceives,
        }),
      },
    }),
  );
  await create(config.eventsQueueName);
}

if (import.meta.main) {
  const config = messagingConfig();
  if (!config.endpoint) throw new Error('Local provisioning requires SQS_ENDPOINT');
  const client = new SQSClient({ region: config.region, endpoint: config.endpoint });
  try {
    await provisionQueues(client, config);
  } finally {
    client.destroy();
  }
}
