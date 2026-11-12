import type { ArgumentsHost, ExceptionFilter, Type } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from 'nestjs-pino';

import { logger, safeId, trace, withTrace } from '../observability/telemetry';
import { setupSwagger } from './openapi';

class BoundaryFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : error instanceof Error &&
            'status' in error &&
            (error.status === 413 || error.status === 415)
          ? error.status
          : 500;
    response.status(status).json({
      code: status === 404 ? 'NOT_FOUND' : status < 500 ? 'INVALID_PAYLOAD' : 'INTERNAL_ERROR',
      correlationId: trace().correlationId,
    });
  }
}
export async function createHttpApplication(module: Type): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(module, {
    logger,
    abortOnError: false,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  app.use((req: Request, res: Response, next: NextFunction) => {
    withTrace(
      { correlationId: safeId(req.headers['x-correlation-id']) ?? crypto.randomUUID() },
      () => {
        res.setHeader('x-correlation-id', trace().correlationId ?? '');
        next();
      },
    );
  });
  app.useBodyParser('json', { limit: '64kb' });
  app.useGlobalFilters(new BoundaryFilter());
  setupSwagger(app);
  return app;
}
