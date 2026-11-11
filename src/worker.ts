import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { logger } from './infrastructure/observability/telemetry';
import { MessagingModule } from './infrastructure/messaging/messaging.module';

try {
  const app = await NestFactory.createApplicationContext(MessagingModule, { logger, abortOnError: false });
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  logger.event('Workers started');
} catch { logger.event('startup_failed', {}, 'error'); process.exit(1); }
