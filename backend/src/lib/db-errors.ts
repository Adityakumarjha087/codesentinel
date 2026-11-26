import { AppError } from './errors.js';

/** Map Postgres constraint/format errors (possibly wrapped by Drizzle) to clean 4xx responses. */
export function mapDatabaseError(error: unknown): AppError | null {
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 4; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') {
      switch (code) {
        case '23505':
          return new AppError(409, 'conflict', 'A resource with the same unique value already exists');
        case '23503':
          return new AppError(409, 'conflict', 'The operation references a resource that does not exist');
        case '23502':
        case '23514':
          return new AppError(400, 'bad_request', 'The request violates a data constraint');
        case '22P02':
        case '22003':
        case '22001':
          return new AppError(400, 'bad_request', 'Invalid input value');
      }
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}
