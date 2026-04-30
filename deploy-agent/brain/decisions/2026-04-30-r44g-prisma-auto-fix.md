# R44g — Prisma Auto-Fix in Pipeline

**Date**: 2026-04-30
**Status**: Active

## Context

Vibe-coded Next.js + Prisma projects (legal-flow being the canonical case)
routinely fail at `next build` inside Cloud Build with:

```
Error: PrismaClient did not initialize yet. Please run `prisma generate`
```

Why this happens:

1. `next build` collects page data → imports `@prisma/client` → throws if
   the generated client is missing.
2. The user's Dockerfile has no `RUN prisma generate` step.
3. Adding a `package.json#postinstall` hook that runs `prisma generate`
   doesn't help because multi-stage Dockerfiles only `COPY package*.json`
   into the deps stage, so `prisma/schema.prisma` isn't there yet.
4. wave-deploy-agent preserves user-uploaded Dockerfiles unchanged
   (`pipeline-worker.ts` Step 2 only auto-generates when
   `!detection.hasDockerfile`).

R44a–R44f were all about Windows-zip path normalization. R44g is a
different bug class: missing build step in user-supplied Dockerfile.

## Decision

Add a `prisma-fixer` module that:

1. **Detects Prisma usage** via three signals:
   - `@prisma/client` or `prisma` in `package.json` deps/devDeps
   - `prisma/schema.prisma` or `schema.prisma` exists
   - `prisma.config.{ts,js,mjs}` exists

   Any one signal → `hasPrisma = true`. Stored on `DetectionResult` so
   downstream steps can branch on it.

2. **Patches user-supplied Dockerfile** in pipeline-worker Step 2 when
   `hasDockerfile && hasPrisma`:
   - Find first `RUN` line matching the build command
     (`npm run build`, `yarn build`, `pnpm build`, `bun run build`,
     `next build`, `npx next build`)
   - Inject right before it, preserving leading whitespace:
     ```
     RUN DATABASE_URL="file:/tmp/prisma-build-placeholder.db" npx prisma generate
     ```
   - Idempotent: skip if `prisma generate` already in the Dockerfile.

3. **Auto-generated Dockerfile** in `dockerfile-gen.ts` Next.js path:
   when `d.hasPrisma === true`, emit the same `RUN DATABASE_URL=… npx
   prisma generate` line in the builder stage between `COPY . .` and
   `RUN npm run build`.

### Why DATABASE_URL placeholder

Most Prisma schemas use:

```prisma
datasource db {
  url = env("DATABASE_URL")
}
```

`prisma generate` validates the env at parse time. We pass a harmless
SQLite placeholder (`file:/tmp/prisma-build-placeholder.db`) so generate
succeeds during build. Runtime DATABASE_URL comes from Cloud Run env
vars and overrides this.

### Why builder stage, not deps stage

Multi-stage Dockerfiles only `COPY package*.json ./` into the deps stage.
The schema isn't there yet. Builder stage runs `COPY . .` first so the
schema is present.

### Security

- DATABASE_URL placeholder is hard-coded in the source. The optional
  `databaseUrlPlaceholder` parameter is rejected if it contains `\n`,
  `\r`, or `"` (Dockerfile injection guard).
- We only patch the FIRST matching build line. A malicious Dockerfile
  with multiple builders gets prisma generate before only the first.

## Consequences

### Pros

- legal-flow and similar Prisma projects deploy on first try without
  user editing the Dockerfile.
- Zero-config: user just zips their project and uploads.
- Idempotent: safe to re-run on a Dockerfile that already has
  `prisma generate`.
- Pure function (`patchDockerfileForPrisma`): no I/O, easy to test.

### Cons

- Patches user's Dockerfile silently — user might not notice.
  Mitigated by `[Pipeline]` log line: `R44g: patched user Dockerfile`.
- Build line regex is heuristic. Custom build commands like
  `RUN make build` won't match.
- DATABASE_URL placeholder works for SQLite but a Postgres-only schema
  with strict URL validation might still fail. Acceptable for the
  current target (vibe-coded SQLite + Next.js).

### Tests

- `apps/api/src/test-prisma-fixer.ts`: 56 zero-dep tests covering all
  three functions, idempotency, line-injection guards, multiple build
  patterns, whitespace preservation.
- `apps/api/src/test-dockerfile-gen.ts`: 6 new R44g tests for the
  auto-generated Dockerfile path.

## Files

- **New**: `apps/api/src/services/prisma-fixer.ts` (3 exports)
- **New**: `apps/api/src/test-prisma-fixer.ts` (56 tests)
- **Modified**: `apps/api/src/services/project-detector.ts`
  (added `hasPrisma` to `DetectionResult`, populated via prisma-fixer)
- **Modified**: `apps/api/src/services/dockerfile-gen.ts`
  (Next.js path injects prisma generate when `d.hasPrisma === true`)
- **Modified**: `apps/api/src/services/pipeline-worker.ts`
  (Step 2 patches user Dockerfile when `hasDockerfile && hasPrisma`)
- **Modified**: `apps/api/src/test-dockerfile-gen.ts`
  (6 new R44g tests)
