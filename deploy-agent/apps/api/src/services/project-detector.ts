import fs from 'node:fs';
import path from 'node:path';
import { safeParsePort } from '../utils/safe-number.js';
import { detectPrismaSignals, isPrismaProject } from './prisma-fixer.js';

export interface DetectionResult {
  language: string;
  framework: string | null;
  entrypoint: string | null;
  packageManager: string | null;
  hasDockerfile: boolean;
  hasDockerCompose: boolean;
  port: number;
  envVars: string[];
  /**
   * R44g: Project uses Prisma. When true, the deploy pipeline must inject
   * `prisma generate` into the Dockerfile (auto-gen path) or patch the
   * user-supplied Dockerfile (preserve path) before `next build` /
   * `npm run build`, otherwise the build fails with
   * "PrismaClient did not initialize yet."
   */
  hasPrisma: boolean;
}

export function detectProject(projectDir: string): DetectionResult {
  const files = listFiles(projectDir);
  const fileNames = new Set(files.map((f) => path.basename(f)));
  const result: DetectionResult = {
    language: 'unknown',
    framework: null,
    entrypoint: null,
    packageManager: null,
    hasDockerfile: fileNames.has('Dockerfile') || fileNames.has('dockerfile'),
    hasDockerCompose: fileNames.has('docker-compose.yml') || fileNames.has('docker-compose.yaml'),
    port: 3000,
    envVars: [],
    hasPrisma: isPrismaProject(detectPrismaSignals(projectDir)),
  };

  // Node.js / TypeScript
  if (fileNames.has('package.json')) {
    result.language = 'typescript';
    const pkg = readJson(path.join(projectDir, 'package.json'));
    if (pkg) {
      // Detect package manager
      if (fileNames.has('bun.lockb') || fileNames.has('bun.lock')) result.packageManager = 'bun';
      else if (fileNames.has('pnpm-lock.yaml')) result.packageManager = 'pnpm';
      else if (fileNames.has('yarn.lock')) result.packageManager = 'yarn';
      else result.packageManager = 'npm';

      // Detect framework
      const deps: Record<string, string> = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) };
      if (deps['next']) { result.framework = 'nextjs'; result.port = 3000; }
      else if (deps['nuxt']) { result.framework = 'nuxt'; result.port = 3000; }
      else if (deps['@sveltejs/kit']) { result.framework = 'sveltekit'; result.port = 5173; }
      else if (deps['express']) { result.framework = 'express'; result.port = 3000; }
      else if (deps['fastify']) { result.framework = 'fastify'; result.port = 3000; }
      else if (deps['hono']) { result.framework = 'hono'; result.port = 3000; }

      // Check if it's JS not TS
      if (!deps['typescript'] && !fileNames.has('tsconfig.json')) {
        result.language = 'javascript';
      }

      // Detect entrypoint
      if (pkg.main) result.entrypoint = String(pkg.main);
      else if ((pkg.scripts as Record<string, string> | undefined)?.start) result.entrypoint = 'npm start';
    }

    // Detect env vars from .env.example
    result.envVars = detectEnvVars(projectDir);
  }

  // Python
  else if (fileNames.has('requirements.txt') || fileNames.has('pyproject.toml') || fileNames.has('Pipfile')) {
    result.language = 'python';
    result.packageManager = fileNames.has('Pipfile') ? 'pipenv' : fileNames.has('pyproject.toml') ? 'poetry' : 'pip';
    result.port = 8000;

    if (fileNames.has('manage.py')) { result.framework = 'django'; result.port = 8000; }
    else if (files.some((f) => f.includes('app.py') || f.includes('main.py'))) {
      const content = safeRead(path.join(projectDir, 'app.py')) || safeRead(path.join(projectDir, 'main.py')) || '';
      if (content.includes('FastAPI')) { result.framework = 'fastapi'; result.port = 8000; }
      else if (content.includes('Flask')) { result.framework = 'flask'; result.port = 5000; }
    }

    result.envVars = detectEnvVars(projectDir);
  }

  // Go
  else if (fileNames.has('go.mod')) {
    result.language = 'go';
    result.port = 8080;
    result.envVars = detectEnvVars(projectDir);
  }

  // Static site
  else if (fileNames.has('index.html') && !fileNames.has('package.json')) {
    result.language = 'static';
    result.framework = 'static';
    result.port = 8080;
  }

  // If Dockerfile exists, check EXPOSE directive to override detected port
  // This handles cases like Vite/React built to static + served by nginx on port 80
  if (result.hasDockerfile) {
    const dockerfilePath = path.join(projectDir, 'Dockerfile');
    const dockerContent = safeRead(dockerfilePath);
    if (dockerContent) {
      // Priority: ENV PORT=X > EXPOSE Y > nginx default
      // ENV PORT is what the app actually listens on at runtime
      // (safeParsePort rejects non-port-range values; the regex always captures
      // digits, but a giant `EXPOSE 99999999999` would produce a non-port int.)
      const envPortMatch = dockerContent.match(/^ENV\s+PORT[=\s]+(\d+)/m);
      if (envPortMatch) {
        const parsed = safeParsePort(envPortMatch[1]);
        if (parsed !== null) result.port = parsed;
      } else {
        const exposeMatch = dockerContent.match(/^EXPOSE\s+(\d+)/m);
        if (exposeMatch) {
          const exposedPort = safeParsePort(exposeMatch[1]);
          if (exposedPort !== null && exposedPort !== result.port) {
            result.port = exposedPort;
          }
        }
        // Also detect nginx-based images (port 80 by default even without EXPOSE)
        if (dockerContent.match(/FROM\s+nginx/i) && !dockerContent.match(/^EXPOSE/m)) {
          result.port = 80;
        }
      }
    }
  }

  return result;
}

function detectEnvVars(dir: string): string[] {
  const envFiles = ['.env.example', '.env.sample', '.env.template'];
  for (const f of envFiles) {
    const content = safeRead(path.join(dir, f));
    if (content) {
      return content
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('#'))
        .map((line) => line.split('=')[0].trim())
        .filter(Boolean);
    }
  }
  return [];
}

function listFiles(dir: string, prefix = ''): string[] {
  const results: string[] = [];
  const skipDirs = new Set(['node_modules', '.git', '.next', '__pycache__', 'venv', '.venv', 'dist', 'build']);

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        results.push(...listFiles(path.join(dir, entry.name), path.join(prefix, entry.name)));
      }
    } else {
      results.push(path.join(prefix, entry.name));
    }
  }
  return results;
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
