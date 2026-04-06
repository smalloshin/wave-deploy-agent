import type { DetectionResult } from './project-detector';

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
  const installCmd = pm === 'bun' ? 'bun install --frozen-lockfile'
    : pm === 'pnpm' ? 'pnpm install --frozen-lockfile'
    : pm === 'yarn' ? 'yarn install --frozen-lockfile'
    : 'npm ci';
  const buildCmd = d.framework === 'nextjs' ? 'npm run build' : 'npm run build';
  const baseImage = pm === 'bun' ? 'oven/bun:1' : 'node:22-alpine';

  if (d.framework === 'nextjs') {
    return `# Multi-stage build for Next.js
FROM ${baseImage} AS deps
WORKDIR /app
COPY package*.json ${pm === 'bun' ? 'bun.lock*' : pm === 'pnpm' ? 'pnpm-lock.yaml*' : pm === 'yarn' ? 'yarn.lock*' : 'package-lock.json*'} ./
RUN ${installCmd}

FROM ${baseImage} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN ${buildCmd}

FROM ${baseImage} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${d.port}
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE ${d.port}
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
ENV PORT=${d.port}
EXPOSE ${d.port}
CMD ["node", "${d.entrypoint ?? 'dist/index.js'}"]
`;
}

function generatePythonDockerfile(d: DetectionResult): string {
  const installCmd = d.packageManager === 'poetry'
    ? 'pip install poetry && poetry install --no-dev'
    : d.packageManager === 'pipenv'
    ? 'pip install pipenv && pipenv install --deploy'
    : 'pip install --no-cache-dir -r requirements.txt';

  const startCmd = d.framework === 'django'
    ? 'gunicorn --bind 0.0.0.0:${PORT:-8000} config.wsgi'
    : d.framework === 'fastapi'
    ? 'uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}'
    : d.framework === 'flask'
    ? 'gunicorn --bind 0.0.0.0:${PORT:-5000} app:app'
    : 'python main.py';

  return `FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt* pyproject.toml* Pipfile* ./
RUN ${installCmd}
COPY . .
ENV PORT=${d.port}
EXPOSE ${d.port}
CMD ${JSON.stringify(startCmd.split(' '))}
`;
}

function generateGoDockerfile(d: DetectionResult): string {
  return `FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /server .

FROM alpine:3.20
RUN apk --no-cache add ca-certificates
COPY --from=builder /server /server
ENV PORT=${d.port}
EXPOSE ${d.port}
CMD ["/server"]
`;
}

function generateStaticDockerfile(d: DetectionResult): string {
  return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE ${d.port}
CMD ["nginx", "-g", "daemon off;"]
`;
}
