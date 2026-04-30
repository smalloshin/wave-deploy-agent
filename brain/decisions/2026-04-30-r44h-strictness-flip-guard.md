# R44h — Strictness Flip Guard + Next 16 ESLint Strip

**Date**: 2026-04-30
**Status**: Active

## Context

R44g shipped (Prisma auto-fix in pipeline). legal-flow redeployed via UI.
Cloud Build log confirmed `Step 11/25 RUN DATABASE_URL=... npx prisma
generate` ran cleanly. But the build still died at `next build`:

```
./next.config.ts:9:3
Type error: 'eslint' does not exist in type 'NextConfig'.
   7 |     ignoreBuildErrors: true,
   8 |   },
>  9 |   eslint: {
     |   ^
  10 |     ignoreDuringBuilds: true,
  11 |   },
```

Two distinct bugs collided:

### Bug 1: AI fix step flips strictness flags

The LLM threat-analysis step looked at the user's `next.config.ts`, saw
`typescript: { ignoreBuildErrors: true }` and `eslint: { ignoreDuringBuilds:
true }`, and emitted auto-fixes flipping both to `false`. From the LLM's
view this is "best practice" — don't skip safety checks. But:

1. The LLM doesn't have full type-check / eslint output in context.
2. The user had those flags ON because the project DOES have errors —
   that's the whole point.
3. Flipping to `false` without ALSO fixing every underlying error kills
   the build immediately.

This is a class of fix the LLM cannot safely apply on a vibe-coded
project. Pipeline must refuse it.

### Bug 2: Next.js 16 dropped the `eslint` config key

Before R44h, even with `ignoreDuringBuilds: true` (i.e., AI fix didn't
flip), the type system in Next 16 errors on the existence of the `eslint`
key at all. The official migration: remove the `eslint` block, use
`next lint` separately. Vibe-coded projects scaffolded against older
Next versions still ship the deprecated block.

## Decision

Add `next-config-fixer.ts` with three exports:

### 1. `isStrictnessFlip(originalCode, fixedCode): { isFlip, key? }`

Pure regex check. Returns true iff `originalCode` contains
`<key>: true` AND `fixedCode` contains `<key>: false` for either
`ignoreBuildErrors` or `ignoreDuringBuilds`. Word-boundary anchored so
longer keys don't false-positive.

Wired into pipeline-worker Step 5 (Auto-Fix Application): before
applying any fix, call `isStrictnessFlip(fix.originalCode,
fix.fixedCode)`. If true, push `{ applied: false, explanation:
'Skipped (R44h): refused to flip <key> true→false ...' }` and continue.

### 2. `detectNextMajorVersion(projectDir): number | null`

Reads `package.json#dependencies.next` (or devDependencies), parses major
via `parseMajorVersion`. Handles `^16.0.0`, `~15.4.2`, `16`, `>=15.0.0`,
`v16.0.0`, `15.x`. Returns null on tag versions (`latest`, `canary`),
missing dep, or malformed JSON.

### 3. `stripEslintFromNextConfig(content): { changed, next, reason }`

Pure string transform. Finds top-level `eslint:` key, walks balanced
braces (string-aware, comment-aware via `findMatchingBrace`) to locate
the closing `}`, consumes optional trailing comma + newline, removes
the entire block including its leading indent.

Wired into pipeline-worker Step 2 (Dockerfile Generation, after Prisma
patch): if `detectNextMajorVersion(projectDir) >= 16`, walk
`next.config.{ts,js,mjs}` candidates and apply
`stripEslintFromNextConfig`. Non-fatal try/catch.

### Why a separate fixer module, not inline in pipeline-worker

Pipeline-worker is already too long. Pure modules with zero-dep tests
keep the deploy hot path testable. Same shape as R44g's `prisma-fixer.ts`.

### Why both defenses (R44h-1 + R44h-2) ship together

They're complementary:
- R44h-1 stops the LLM from breaking next-time configs that DON'T have
  the deprecated `eslint` field but DO have `ignoreBuildErrors: true`.
- R44h-2 fixes the legal-flow class of project where the field is
  already deprecated regardless of what the LLM does.

Without both, legal-flow still fails: even if R44h-1 prevents the flip,
the deprecated `eslint` block makes Next 16 type-check fail. Without
R44h-2 alone, every other vibe-coded project with `ignoreBuildErrors`
will still die.

## Consequences

### Pros

- legal-flow + similar Next 16 + Prisma + vibe-coded projects deploy on
  next try.
- LLM threat-fix step gets a guard rail for a known-bad fix class.
- 63 zero-dep tests lock both behaviors.
- Pure functions: `isStrictnessFlip` + `parseMajorVersion` + `findMatchingBrace`
  + `stripEslintFromNextConfig` all I/O-free.
- Idempotent: re-running `stripEslintFromNextConfig` on already-stripped
  content returns `changed: false`.

### Cons

- `stripEslintFromNextConfig` is heuristic: TypeScript parser would be
  more correct but adds dep weight. We accept that exotic configs (e.g.,
  `eslint:` defined via spread `...eslintCfg`) won't be touched. Logged
  but non-fatal.
- R44h-1 only catches `true → false`. If the LLM emits a more elaborate
  rewrite (e.g., removes the whole `typescript: {}` block), we don't
  detect that. Acceptable for now — the `true → false` flip is the
  single observed failure mode.
- Auto-strip silently modifies user code (logged in `[Pipeline]` output
  but not surfaced to dashboard). Acceptable: same posture as R44g.

### Tests

- `apps/api/src/test-next-config-fixer.ts`: 63 zero-dep tests.
  - 14 `isStrictnessFlip` (both keys, edge cases, word-boundary,
    multi-line, input validation).
  - 13 `parseMajorVersion` + `detectNextMajorVersion` (semver shapes,
    tag versions, dependencies vs devDependencies, missing/malformed
    package.json).
  - 19 `stripEslintFromNextConfig` (legal-flow shape, idempotency,
    non-object eslint values, nested objects, CRLF, strings/comments
    inside, unbalanced braces defensive).
  - 9 `findMatchingBrace` low-level invariants.
  - 8 output content shape (no orphan braces, double commas, etc.).

## Files

- **New**: `apps/api/src/services/next-config-fixer.ts` (5 exports,
  ~280 LOC)
- **New**: `apps/api/src/test-next-config-fixer.ts` (63 tests)
- **Modified**: `apps/api/src/services/pipeline-worker.ts`
  - Imports `isStrictnessFlip`, `detectNextMajorVersion`,
    `stripEslintFromNextConfig`.
  - Step 5 (Auto-Fix Application): guards each fix with `isStrictnessFlip`
    before `original.replace`.
  - Step 2 (Dockerfile Generation): after Prisma patch, if Next major
    ≥ 16, walks config candidates and strips `eslint` block.
