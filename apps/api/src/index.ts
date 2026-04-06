import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { projectRoutes } from './routes/projects';
import { reviewRoutes } from './routes/reviews';
import { deployRoutes } from './routes/deploys';
import { mcpRoutes } from './routes/mcp';
import { settingsRoutes } from './routes/settings';
import { projectGroupRoutes } from './routes/project-groups';
import { infraRoutes } from './routes/infra';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
});

// CORS — support comma-separated origins (e.g. "https://a.com,https://b.com")
const corsOrigin = process.env.CORS_ORIGIN ?? '*';
await app.register(cors, {
  origin: corsOrigin === '*' ? true : corsOrigin.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
});

// Multipart file upload (100MB limit)
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

// Health check
app.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
  version: process.env.npm_package_version ?? '0.0.1',
}));

// Register routes
await app.register(projectRoutes);
await app.register(reviewRoutes);
await app.register(deployRoutes);
await app.register(mcpRoutes);
await app.register(settingsRoutes);
await app.register(projectGroupRoutes);
await app.register(infraRoutes);

// Global error handler
app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  app.log.error({ err: error, url: request.url, method: request.method }, 'Request error');

  if (error.name === 'ZodError') {
    return reply.status(400).send({
      error: 'Validation error',
      details: JSON.parse(error.message),
    });
  }

  if (error.name === 'InvalidTransitionError') {
    return reply.status(409).send({ error: error.message });
  }

  return reply.status(error.statusCode ?? 500).send({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
  });
});

// Start
const port = parseInt(process.env.PORT ?? '4000', 10);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
  app.log.info(`Deploy Agent API running on ${host}:${port}`);
} catch (err) {
  app.log.fatal(err);
  process.exit(1);
}
