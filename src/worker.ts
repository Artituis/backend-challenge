import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { MessagingModule } from './infrastructure/messaging/messaging.module';

const app = await NestFactory.createApplicationContext(MessagingModule);
app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
new Logger('Worker').log('Workers started');
