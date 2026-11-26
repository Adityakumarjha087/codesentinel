import { pino, type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';

export type { Logger };

export function loggerOptions(env: Pick<Env, 'LOG_LEVEL' | 'LOG_PRETTY'>): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    base: { service: 'codesentinel' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-hub-signature-256"]', '*.apiKey', '*.token'],
      censor: '[redacted]',
    },
    ...(env.LOG_PRETTY ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  };
}

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'LOG_PRETTY'>): Logger {
  return pino(loggerOptions(env));
}
