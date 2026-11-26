import { loadEnv } from '../config/env.js';
import { createContainer } from '../container.js';
import { seedDatabase } from './seed-data.js';

const env = loadEnv();
const container = await createContainer(env);
const summary = await seedDatabase(container, { reset: process.argv.includes('--reset') });
console.log(JSON.stringify(summary));
await container.close();
