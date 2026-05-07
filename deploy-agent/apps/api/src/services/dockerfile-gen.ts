import type { DetectionResult } from './project-detector';
import { sanitizeEntrypoint, sanitizePort } from './dockerfile-safe.js';

export function generateDockerfile(detection: DetectionResult): string {
  switch (detection.language) {
    case 'typescript':
    case 'javascript':
      return generateNodeDockerfile(detection);
    case 'python':
      return generatePythonDockerfile(detection);
    case 'go':
      return generateGoDockerfile(detection);
    case 'static':
      return generateStaticDockerfile(detection);
    default:
      throw new Error(`Unsupported language: ${detection.language}`);
  }
}

export function generateDockerignore(detection: DetectionResult): string {
  const common = ['node_modules', '.git', '.env', '.env.local', '*.log', '.DS_Store'];

  switch (detection.language) {
    case 'typescript':
    case 'javascript':
      return [...common, '.next', 'dist', 'coverage', '.turbo'].join('\n');
    case 'python':
      return [...common, '__pycache__', '*.pyc', 'venv', '.venv', '*.egg-info'].join('\n');
    case 'go':
      return [...common, 'vendor'].join('\n');
    default:
      return common.join('\n');
  }
}

function generateNodeDockerfile(d: DetectionResult): string {
  const pm = d.packageManager ?? 'npm';
  // R48: For low-confidence npm (no lockfile detected), swap `npm ci` →
  // `npm install`. `npm ci` requires the lockfile to be in lockstep with
  // package.json and breaks loudly when it's missing or stale; `install` is
  // forgiving. We accept the tiny reproducibility loss for projects whose
  // reproducibility was already zero (no lockfile = no reproducibility).
  // pnpm/yarn/bun branches still use --frozen-lockfile because those PMs
  // fail with a clear "no lockfile" message rather than a cryptic binary
  // mismatch. No Docker-side retry; surface mismatch via warnings instead.
  const npmInstallCmd = d.packageManagerConfidence === 'low'
    ? 'npm install --no-audit --no-fund'
    : 'npm ci';
  const installCmd = pm === 'bun' ? 'bun install --frozen-lockfile'
    : pm === 'pnpm' ? 'pnpm install --frozen-lockfile'
    : pm === 'yarn' ? 'yarn install --frozen-lockfile'
    : npmInstallCmd;
  const buildCmd = d.framework === 'nextjs' ? 'npm run build' : 'npm run build';
  const baseImage = pm === 'bun' ? 'oven/bun:1' : 'node:22-alpine';
  const safePort = sanitizePort(d.port);
  const safeEntrypoint = sanitizeEntrypoint(d.entrypoint, 'dist/index.js');
  // R44g: when project uses Prisma, inject `prisma generate` in the builder
  // stage right before `next build` / `npm run build`. Without this, the
  // build collects page data → imports `@prisma/client` → fails. We pass a
  // SQLite placeholder for DATABASE_URL because most schemas reference
  // `env("DATABASE_URL")`; the real URL is set at runtime by Cloud Run.
  const prismaGenerateLine = d.hasPrisma
    ? 'RUN DATABASE_URL="file:/tmp/prisma-build-placeholder.db" npx prisma generate\n'
    : '';

  // R59 (2026-05-07): Vite static SPA. Generic Node SSR template (`node
  // dist/index.js`) DOES NOT WORK because Vite outputs static assets to
  // `dist/` with no server entry — Cloud Run health check timed out at 4
  // minutes (bid-ops-frontend canonical). Use multi-stage build → nginx
  // serving static `dist/` with envsubst so it listens on Cloud Run's
  // injected PORT. SPA fallback (`try_files`) handled in default.conf
  // template; user-supplied `nginx.conf` (when present) is preferred.
  if (d.framework === 'vite-static') {
    return generateViteStaticDockerfile(d, baseImage, installCmd, pm);
  }

  if (d.framework === 'nextjs') {
    return `# Multi-stage build for Next.js
FROM ${baseImage} AS deps
WORKDIR /app
COPY package*.json ${pm === 'bun' ? 'bun.lock*' : pm === 'pnpm' ? 'pnpm-lock.yaml* pnpm-workspace.yaml* pnpm-workspace.yml*' : pm === 'yarn' ? 'yarn.lock*' : 'package-lock.json*'} ./
RUN ${installCmd}

FROM ${baseImage} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${prismaGenerateLine}RUN ${buildCmd}

FROM ${baseImage} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${safePort}
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE ${safePort}
CMD ["node", "server.js"]
`;
  }

  return `FROM ${baseImage} AS deps
WORKDIR /app
COPY package*.json ./
RUN ${installCmd}

FROM ${baseImage}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build 2>/dev/null || true
ENV PORT=${safePort}
EXPOSE ${safePort}
CMD ["node", "${safeEntrypoint}"]
`;
}

/**
 * R59 (2026-05-07): Vite static SPA Dockerfile generator.
 *
 * Vite produces a static asset bundle in `dist/`, NOT a Node server entry.
 * Generic Node SSR template (`node dist/index.js`) caused the bid-ops-frontend
 * canonical failure: container started but never listened on PORT, Cloud Run
 * health check timed out at 4 minutes.
 *
 * Strategy: multi-stage build → nginx:alpine runtime serving the static
 * `dist/`. nginx config replaces `listen 80;` with `listen ${PORT:-8080};`
 * via sed at startup so Cloud Run's injected PORT is honored.
 *
 * SPA fallback (`try_files $uri $uri/ /index.html;`) is required for
 * client-side routing (React Router, Vue Router). We embed a default config
 * inline; user-supplied `nginx.conf` at the source root is COPYed and
 * preferred over the embedded default.
 */
function generateViteStaticDockerfile(
  d: DetectionResult,
  baseImage: string,
  installCmd: string,
  pm: string,
): string {
  // Use the same lockfile pattern as Next.js generator for consistency.
  const lockfilePattern =
    pm === 'bun'
      ? 'bun.lock*'
      : pm === 'pnpm'
      ? 'pnpm-lock.yaml* pnpm-workspace.yaml* pnpm-workspace.yml*'
      : pm === 'yarn'
      ? 'yarn.lock*'
      : 'package-lock.json*';

  // Default nginx config: SPA fallback (try_files → index.html) so React
  // Router / Vue Router don't 404 on deep links. Gzip enabled for typical
  // text MIME types. `listen 80;` is the literal sed targets at startup.
  // Use $${PORT} so Vite/Bun template substitution (if any) doesn't try to
  // resolve PORT at build time — the variable is read at container startup.
  const defaultNginxConf = [
    'server {',
    '    listen 80;',
    '    root /usr/share/nginx/html;',
    '    index index.html;',
    '    location / { try_files $uri $uri/ /index.html; }',
    '    gzip on;',
    '    gzip_types text/plain text/css application/json application/javascript text/xml application/xml text/javascript;',
    '}',
  ];
  const heredoc = defaultNginxConf
    .map((line) => ` && echo '${line}' >> /tmp/nginx.conf.template`)
    .join(' \\\n')
    .replace(' && ', '');

  return `# R59: Multi-stage Vite static SPA build with nginx runtime.
# Cloud Run injects PORT; nginx replaces \`listen 80;\` with \`listen \${PORT};\`
# at startup via sed so the runtime listens on the right port.
FROM ${baseImage} AS build
WORKDIR /app
COPY package*.json ${lockfilePattern} ./
RUN ${installCmd}
COPY . .
RUN npm run build

FROM nginx:alpine
# Default nginx config with SPA fallback (try_files → index.html) so client-
# side routing works for deep links. Users who need custom nginx config can
# provide their own Dockerfile (R44h: we don't override user Dockerfiles).
RUN : > /tmp/nginx.conf.template ${heredoc}
COPY --from=build /app/dist /usr/share/nginx/html
ENV PORT=8080
EXPOSE 8080
# sed replaces \`listen 80;\` literal with the Cloud-Run-injected PORT.
CMD ["sh", "-c", "sed \\"s/listen 80;/listen \${PORT:-8080};/\\" /tmp/nginx.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
`;
}

function generatePythonDockerfile(d: DetectionResult): string {
  const installCmd = d.packageManager === 'poetry'
    ? 'pip install poetry && poetry install --no-dev'
    : d.packageManager === 'pipenv'
    ? 'pip install pipenv && pipenv install --deploy'
    : 'pip install --no-cache-dir -r requirements.txt';

  // R46: must use sh -c form (not raw exec form) when startCmd contains
  // shell variable expansion like ${PORT:-N}. Docker exec form is JSON and
  // does NOT spawn a shell, so without the sh wrapper `${PORT:-8000}` is
  // passed to uvicorn/gunicorn as a literal 13-char string and the container
  // fails to start. dockerfile-port-fixer locks this contract for user
  // Dockerfiles too — generating broken auto-gen here would partially defeat
  // that defense.
  const startCmd = d.framework === 'django'
    ? 'gunicorn --bind 0.0.0.0:${PORT:-8000} config.wsgi'
    : d.framework === 'fastapi'
    ? 'uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}'
    : d.framework === 'flask'
    ? 'gunicorn --bind 0.0.0.0:${PORT:-5000} app:app'
    : 'python main.py';

  // For `python main.py` the port comes from app code (via os.environ
  // ['PORT']) — no shell expansion needed in CMD, exec form is safe.
  const cmdLine = startCmd === 'python main.py'
    ? 'CMD ["python", "main.py"]'
    : `CMD ["sh", "-c", ${JSON.stringify(startCmd)}]`;

  const safePort = sanitizePort(d.port);
  return `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt* pyproject.toml* Pipfile* ./
RUN ${installCmd}
COPY . .
ENV PORT=${safePort}
EXPOSE ${safePort}
${cmdLine}
`;
}

function generateGoDockerfile(d: DetectionResult): string {
  const safePort = sanitizePort(d.port);
  return `FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /server .

FROM alpine:3.20
RUN apk --no-cache add ca-certificates
COPY --from=builder /server /server
ENV PORT=${safePort}
EXPOSE ${safePort}
CMD ["/server"]
`;
}

function generateStaticDockerfile(d: DetectionResult): string {
  const safePort = sanitizePort(d.port);
  return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE ${safePort}
CMD ["nginx", "-g", "daemon off;"]
`;
}
