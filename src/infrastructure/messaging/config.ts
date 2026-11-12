export interface MessagingConfig {
  region: string;
  endpoint?: string;
  queueName: string;
  dlqName: string;
  eventsQueueName: string;
  consumerName: string;
  consumerConcurrency: number;
  publisherConcurrency: number;
  visibilitySeconds: number;
  maxReceives: number;
  pollSeconds: number;
  requestTimeoutMs: number;
  shutdownMs: number;
  idleMs: number;
  pendingTtlMs: number;
  pendingBaseDelayMs: number;
  pendingMaxDelayMs: number;
}

export function messagingConfig(env: NodeJS.ProcessEnv = process.env): MessagingConfig {
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const config: MessagingConfig = {
    region: env['AWS_REGION'] ?? 'us-east-1',
    ...(env['SQS_ENDPOINT'] ? { endpoint: env['SQS_ENDPOINT'] } : {}),
    queueName: env['SQS_QUEUE_NAME'] ?? 'wager-transactions.fifo',
    dlqName: env['SQS_DLQ_NAME'] ?? 'wager-transactions-dlq.fifo',
    eventsQueueName: env['SQS_EVENTS_QUEUE_NAME'] ?? 'wager-events.fifo',
    consumerName: 'wager-transactions-v1',
    consumerConcurrency: integer('CONSUMER_CONCURRENCY', 4, 1, 32),
    publisherConcurrency: integer('OUTBOX_CONCURRENCY', 2, 1, 8),
    visibilitySeconds: integer('SQS_VISIBILITY_SECONDS', 60, 30, 43200),
    maxReceives: integer('SQS_MAX_RECEIVES', 5, 1, 100),
    pollSeconds: integer('SQS_POLL_SECONDS', 20, 1, 20),
    requestTimeoutMs: integer('SQS_REQUEST_TIMEOUT_MS', 5000, 100, 15000),
    shutdownMs: integer('WORKER_SHUTDOWN_MS', 25000, 1000, 120000),
    idleMs: integer('WORKER_IDLE_MS', 1000, 10, 60000),
    pendingTtlMs: integer('PENDING_REFERENCE_TTL_MS', 86400000, 1000, 2592000000),
    pendingBaseDelayMs: integer('PENDING_REFERENCE_BASE_DELAY_MS', 1000, 1, 3600000),
    pendingMaxDelayMs: integer('PENDING_REFERENCE_MAX_DELAY_MS', 300000, 1, 86400000),
  };
  if (config.pendingMaxDelayMs < config.pendingBaseDelayMs)
    throw new Error('Pending max delay must be >= base delay');
  if (config.requestTimeoutMs >= (config.visibilitySeconds * 1000) / 3)
    throw new Error('SQS request timeout must be shorter than heartbeat interval');
  return config;
}
