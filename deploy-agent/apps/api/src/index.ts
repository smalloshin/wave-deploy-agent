import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { projectRoutes } from './routes/projects';
import { reviewRoutes } from './routes/reviews';
import { deployRoutes } from './routes/deploys';
import { mcpRoutes } from './routes/mcp';
import { settingsRoutes } from './routes/settings';
import { projectGroupRoutes } from './routes/project-groups';
import { infraRoutes } from './routes/infra';
import { versioningRoutes } from './routes/versioning';
import { webhookRoutes } from './routes/webhooks';
import { authRoutes } from './routes/auth';
import { registerAuthHook, registerAuthCoverageCheck } from './middleware/auth';
import { ensureAdmin } from './services/auth-service';
import { startReconciler } from './services/reconciler';
import { startAuthCleanup } from './services/auth-cleanup';
import { runMigrations } from './db/migrate';
import { safePositiveInt } from './utils/safe-number';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
});

// CORS — support comma-separated origins (e.g. "https://a.com,https://b.com")
// credentials:true required for session cookies to flow cross-origin.
const corsOrigin = process.env.CORS_ORIGIN ?? '*';
await app.register(cors, {
  origin: corsOrigin === '*' ? true : corsOrigin.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  credentials: true,
});

// Multipart file upload (100MB limit)
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

// Cookie (for session cookies)
await app.register(cookie, {
  secret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
});

// Global rate limit (600 req/min per IP — ~10/sec); individual routes override (login = 5/min).
// 600 because 4 pages poll at 5s interval across tabs; behind shared NAT a whole team shares one IP.
// /health excluded so Cloud Run probe doesn't burn the budget.
await app.register(rateLimit, {
  global: true,
  // safePositiveInt: env var is user-supplied → `Number("abc")` would give NaN
  // and disable the limiter silently. Floor at 1, cap at 100k (sanity).
  max: safePositiveInt(process.env.RATE_LIMIT_MAX, 600, { max: 100_000 }),
  timeWindow: '1 minute',
  allowList: (req) => req.url === '/health',
});

// Auth hook (runs before all routes; skips public routes internally)
registerAuthHook(app);

// RBAC coverage check — onRoute hook walks every registered route and warns
// at boot about any route that isn't in ROUTE_PERMISSIONS / PUBLIC / AUTHENTICATED.
// Must be registered BEFORE route plugins so the hook catches all of them.
registerAuthCoverageCheck(app);

// Health check
app.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
  version: process.env.npm_package_version ?? '0.0.1',
  auth_mode: process.env.AUTH_MODE ?? 'permissive',
}));

// Register routes
await app.register(authRoutes);
await app.register(projectRoutes);
await app.register(reviewRoutes);
await app.register(deployRoutes);
await app.register(mcpRoutes);
await app.register(settingsRoutes);
await app.register(projectGroupRoutes);
await app.register(infraRoutes);
try {
  await app.register(versioningRoutes);
  console.log('[startup] Versioning routes registered OK');
} catch (err) {
  console.error('[startup] VERSIONING ROUTES FAILED TO REGISTER:', (err as Error).message);
  console.error('[startup] Stack:', (err as Error).stack);
}
try {
  await app.register(webhookRoutes);
  console.log('[startup] Webhook routes registered OK');
} catch (err) {
  console.error('[startup] WEBHOOK ROUTES FAILED TO REGISTER:', (err as Error).message);
  console.error('[startup] Stack:', (err as Error).stack);
}

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
// safePositiveInt: PORT="abc" → NaN → listen() throws; fall back to 4000.
const port = safePositiveInt(process.env.PORT, 4000, { max: 65535 });
const host = process.env.HOST ?? '0.0.0.0';

try {
  // Auto-run migrations before starting (idempotent — safe to run every boot)
  try {
    await runMigrations();
    app.log.info('Database migrations completed');
  } catch (err) {
    app.log.error({ err }, 'Migration failed — continuing with existing schema');
  }

  // Bootstrap admin user if configured (only creates if no user with that email exists)
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    try {
      await ensureAdmin(
        process.env.ADMIN_EMAIL,
        process.env.ADMIN_PASSWORD,
        process.env.ADMIN_DISPLAY_NAME,
      );
    } catch (err) {
      app.log.error({ err }, 'Admin bootstrap failed');
    }
  }

  await app.listen({ port, host });
  app.log.info(`Deploy Agent API running on ${host}:${port}`);
  // Start the pipeline reconciler (recovers projects stuck in intermediate
  // states after a container restart). Non-blocking.
  startReconciler();
  // Periodic auth-table cleanup (expired sessions + old audit log rows).
  // Without this, both tables grow unbounded — sessions because the rows
  // outlive the cookie; audit log because every request adds a row.
  startAuthCleanup();
} catch (err) {
  app.log.fatal(err);
  process.exit(1);
}
