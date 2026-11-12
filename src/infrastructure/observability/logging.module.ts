import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { pinoLogger } from './telemetry';

export class LoggingModule {}
Module({
  imports: [
    LoggerModule.forRoot({
      // httpHandler emits the single completion event, with committed transaction IDs.
      pinoHttp: {
        logger: pinoLogger,
        autoLogging: false,
        quietReqLogger: true,
        serializers: {
          req: () => undefined,
          res: () => undefined,
          err: () => undefined,
        },
      },
    }),
  ],
  exports: [LoggerModule],
})(LoggingModule);
