import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { logger } from './infrastructure/observability/telemetry';

try {
  const app = await NestFactory.createApplicationContext(MessagingModule, {
    logger,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  logger.event('Workers started');
} catch {
  logger.event('startup_failed', {}, 'error');
  process.exit(1);
}
