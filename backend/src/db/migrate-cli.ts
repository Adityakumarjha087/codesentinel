import { loadEnv } from '../config/env.js';
import { createDatabase } from './client.js';

const env = loadEnv();
const handle = await createDatabase({ driver: env.DATABASE_DRIVER, url: env.DATABASE_URL });
await handle.migrate();
await handle.close();
console.log('Migrations applied');
