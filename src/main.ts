import 'reflect-metadata';

import { createHttpApplication } from './infrastructure/http/bootstrap';
import { HttpModule } from './infrastructure/http/http.module';
import { logger } from './infrastructure/observability/telemetry';

try {
  const app = await createHttpApplication(HttpModule);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  const port = Number(process.env['PORT'] ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTP port');
  await app.listen(port, '0.0.0.0');
} catch {
  logger.event('startup_failed', {}, 'error');
  process.exit(1);
}
