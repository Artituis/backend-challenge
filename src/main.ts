import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { HttpModule } from './infrastructure/http/http.module';
import { logger } from './infrastructure/observability/telemetry';

try {
  const app = await NestFactory.createApplicationContext(HttpModule, { logger, abortOnError: false });
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
} catch { logger.event('startup_failed', {}, 'error'); process.exit(1); }
