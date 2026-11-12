import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';

import type { HealthService } from '../health/health.module';
import { bindTrace, logger, metrics, safeId, trace, withTrace } from '../observability/telemetry';
import type { Api } from './api';
import { httpError } from './api';

/** Bun HTTP boundary; Nest owns dependencies and graceful shutdown. */
export function httpHandler(
  health: HealthService,
  api?: Pick<Api, 'handle'>,
): (request: Request) => Promise<Response> {
  return (request) =>
    withTrace(
      { correlationId: safeId(request.headers.get('x-correlation-id')) ?? crypto.randomUUID() },
      async () => {
        const started = performance.now();
        let response: Response;
        const path = new URL(request.url).pathname;
        try {
          if (request.method === 'GET' && path === '/health/live')
            response = Response.json(health.live());
          else if (request.method === 'GET' && (path === '/health/ready' || path === '/health')) {
            const result = await health.ready();
            response = Response.json(result, { status: result.status === 'ok' ? 200 : 503 });
          } else if (request.method === 'GET' && path === '/metrics') {
            response = new Response(metrics.render(), {
              headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
            });
          } else if (api) response = await api.handle(request);
          else response = Response.json({ code: 'NOT_FOUND' }, { status: 404 });
        } catch (error) {
          const failure = httpError(error);
          response = Response.json(
            { code: failure.code, correlationId: trace().correlationId },
            { status: failure.status },
          );
        }
        // HTTP has no broker delivery ID. Keep messageId null rather than trusting a client-supplied value.
        bindTrace({ correlationId: trace().correlationId! });
        response.headers.set('x-correlation-id', trace().correlationId!);
        const durationMs = performance.now() - started;
        metrics.observe('http_processing', durationMs / 1000);
        logger.event('http_completed', { status: String(response.status), durationMs });
        return response;
      },
    );
}

export class HttpServer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private server: ReturnType<typeof Bun.serve> | undefined;
  constructor(
    private readonly health: HealthService,
    private readonly api?: Api,
    private readonly port = 3000,
  ) {}
  onApplicationBootstrap(): void {
    this.server = Bun.serve({
      hostname: '0.0.0.0',
      port: this.port,
      maxRequestBodySize: 64 * 1024,
      fetch: httpHandler(this.health, this.api),
      error: () => Response.json({ code: 'INVALID_PAYLOAD' }, { status: 400 }),
    });
    logger.event('http_started');
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.server?.stop();
  }
}
