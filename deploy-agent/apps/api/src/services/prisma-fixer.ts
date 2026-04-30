/**
 * Prisma fixer (R44g)
 *
 * Vibe-coded Next.js + Prisma projects routinely fail at `next build` because
 * the build collects page data → imports `@prisma/client` → throws
 *   "PrismaClient did not initialize yet. Please run `prisma generate`"
 *
 * The user-supplied Dockerfile usually has no `prisma generate` step, and the
 * wave-deploy-agent preserves user Dockerfiles unchanged. We patch the
 * Dockerfile in the builder stage right before the build command runs.
 *
 * Why inject in the BUILDER stage (after `COPY . .`) and not the deps stage:
 *   - Multi-stage Dockerfiles only `COPY package*.json` into deps, so
 *     `prisma/schema.prisma` is not present in deps. Running `prisma generate`
 *     there would fail with "schema.prisma not found".
 *   - Builder stage runs `COPY . .` which brings in the schema.
 *   - We also can't rely on a `package.json#postinstall` hook because
 *     deps stage runs `npm ci` before schema is copied.
 *
 * Why DATABASE_URL placeholder:
 *   - Most Prisma schemas use `datasource db { url = env("DATABASE_URL") }`.
 *     `prisma generate` reads the schema and validates env at parse time.
 *     We inject a harmless SQLite placeholder so generate succeeds during
 *     the build; runtime DATABASE_URL is set by Cloud Run env vars.
 *
 * This module is pure (except detect, which reads files). No DB, no network.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface PrismaSignals {
  /** `@prisma/client` in dependencies or devDependencies */
  hasPrismaInDeps: boolean;
  /** `prisma/schema.prisma` exists at any depth (we only check root + prisma/) */
  hasPrismaSchema: boolean;
  /** `prisma.config.ts` or `prisma.config.js` exists at root */
  hasPrismaConfig: boolean;
}

const DEFAULT_DB_URL_PLACEHOLDER = 'file:/tmp/prisma-build-placeholder.db';

export interface PatchResult {
  /** Whether the Dockerfile content changed */
  changed: boolean;
  /** New Dockerfile content (== input if unchanged) */
  next: string;
  /** Human-readable reason for the change/non-change */
  reason: string;
}

/**
 * Detect Prisma usage signals from a project directory.
 * Pure on the filesystem: only reads, never writes.
 */
export function detectPrismaSignals(projectDir: string): PrismaSignals {
  return {
    hasPrismaInDeps: hasPrismaInPackageJson(projectDir),
    hasPrismaSchema: hasPrismaSchemaFile(projectDir),
    hasPrismaConfig: hasPrismaConfigFile(projectDir),
  };
}

/**
 * Project is "Prisma" if any signal is positive.
 * One signal is enough — devs often have schema but no @prisma/client yet,
 * or @prisma/client but schema in a non-standard location.
 */
export function isPrismaProject(s: PrismaSignals): boolean {
  return s.hasPrismaInDeps || s.hasPrismaSchema || s.hasPrismaConfig;
}

/**
 * Patch a Dockerfile string to inject `prisma generate` before the build step.
 *
 * Rules:
 *   - Idempotent: if the Dockerfile already contains `prisma generate` (any
 *     casing, any flags), return changed=false.
 *   - Find the FIRST line matching `RUN\s+(npm|yarn|pnpm|bun)\s+(run\s+)?build`
 *     OR `RUN\s+(npx\s+)?next\s+build` and inject the prisma generate line
 *     immediately before it, preserving leading whitespace.
 *   - If no build line is found, return changed=false with a reason.
 *   - Never modifies any other line.
 *
 * Pure function: input → output, no I/O.
 */
export function patchDockerfileForPrisma(
  content: string,
  options?: { databaseUrlPlaceholder?: string },
): PatchResult {
  if (typeof content !== 'string') {
    return { changed: false, next: '', reason: 'invalid input: content not a string' };
  }

  // Idempotency check — if `prisma generate` already there, skip.
  if (/\bprisma\s+generate\b/i.test(content)) {
    return { changed: false, next: content, reason: 'Dockerfile already runs prisma generate' };
  }

  const placeholder = options?.databaseUrlPlaceholder ?? DEFAULT_DB_URL_PLACEHOLDER;
  // Defensive: reject placeholders that contain newlines or double quotes —
  // those would break out of the RUN line and inject extra Dockerfile commands.
  if (/[\n\r"]/.test(placeholder)) {
    return {
      changed: false,
      next: content,
      reason: 'unsafe DATABASE_URL placeholder (contains newline or quote)',
    };
  }

  const lines = content.split('\n');
  // Find first RUN that runs a build command. Allow leading whitespace.
  // Patterns: RUN npm run build, RUN yarn build, RUN pnpm build, RUN bun run build,
  // RUN npx next build, RUN next build, RUN npm run build && something
  const buildPattern =
    /^(\s*)RUN\s+(?:npm\s+run\s+build|yarn\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|bun\s+run\s+build|(?:npx\s+)?next\s+build)\b/i;

  let buildLineIdx = -1;
  let leadingWs = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(buildPattern);
    if (m) {
      buildLineIdx = i;
      leadingWs = m[1] ?? '';
      break;
    }
  }

  if (buildLineIdx === -1) {
    return {
      changed: false,
      next: content,
      reason: 'no build step found (looked for npm/yarn/pnpm/bun/next build)',
    };
  }

  const prismaLine = `${leadingWs}RUN DATABASE_URL="${placeholder}" npx prisma generate`;
  const next = [
    ...lines.slice(0, buildLineIdx),
    prismaLine,
    ...lines.slice(buildLineIdx),
  ].join('\n');

  return {
    changed: true,
    next,
    reason: `injected prisma generate before line ${buildLineIdx + 1}`,
  };
}

// ───────────────────── internal helpers ─────────────────────

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasPrismaInPackageJson(projectDir: string): boolean {
  const pkg = safeReadJson(path.join(projectDir, 'package.json'));
  if (!pkg) return false;
  const deps = (pkg.dependencies ?? {}) as Record<string, unknown>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, unknown>;
  return Boolean(deps['@prisma/client']) || Boolean(devDeps['@prisma/client']) ||
    Boolean(deps['prisma']) || Boolean(devDeps['prisma']);
}

function hasPrismaSchemaFile(projectDir: string): boolean {
  // Look in conventional locations only — recursive scan is overkill.
  const candidates = [
    path.join(projectDir, 'prisma', 'schema.prisma'),
    path.join(projectDir, 'schema.prisma'),
  ];
  return candidates.some((p) => safeIsFile(p));
}

function hasPrismaConfigFile(projectDir: string): boolean {
  const candidates = [
    path.join(projectDir, 'prisma.config.ts'),
    path.join(projectDir, 'prisma.config.js'),
    path.join(projectDir, 'prisma.config.mjs'),
  ];
  return candidates.some((p) => safeIsFile(p));
}

function safeIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
