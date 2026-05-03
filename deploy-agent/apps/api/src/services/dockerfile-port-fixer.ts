/**
 * Dockerfile port fixer (R46)
 *
 * Cloud Run injects a `PORT` env var (default 8080, configurable per service)
 * and probes that port for the startup health check. Two failure modes we
 * see in vibe-coded user Dockerfiles:
 *
 * 1. EXEC FORM VARIABLE LEAK
 *    `CMD ["uvicorn", "app:app", "--port", "${PORT:-8000}"]`
 *    Docker exec form is JSON. Docker does NOT spawn a shell. The string
 *    `${PORT:-8000}` is passed to uvicorn as a literal 13-char string and
 *    crashes the container at startup with a port parse error. The
 *    misleading thing is the comment users (and our own auto-gen, prior
 *    to this round) write right above: "PORT env var will be respected."
 *    It will not.
 *
 * 2. HARDCODED PORT MISMATCH WITH CLOUD RUN
 *    `CMD ["uvicorn", "app:app", "--port", "8080"]`
 *    If the Cloud Run revision is configured for PORT=8000 but CMD hardcodes
 *    8080, the container listens on 8080, Cloud Run probes 8000, and after
 *    ~4 minutes the deploy fails with:
 *      "container failed to start and listen on the port defined provided
 *       by the PORT environment variable within the allocated timeout"
 *    luca-optimizer-kb (R45-era canonical) hit this exactly.
 *
 * Both cases are fixed by rewriting the directive into shell-exec form so
 * the variable expansion actually runs:
 *   CMD ["sh", "-c", "uvicorn app:app --port ${PORT:-8000}"]
 *
 * Frameworks recognized (any literal port adjacent to a known launch flag
 * or a `host:port` argument right after `runserver`/`server`):
 *   - uvicorn:           --port N, --port=N
 *   - gunicorn:          --bind H:N, -b H:N, --bind=H:N, -b=H:N
 *   - flask:             --port N, --port=N, -p N
 *   - django runserver:  python manage.py runserver 0.0.0.0:N
 *   - rails / generic:   --port N, -p N
 *
 * Idempotency:
 *   - `sh -c` / `bash -c` form is left alone (already correctly handled).
 *   - CMD with no recognizable port pattern is left alone.
 *   - First-arg ENTRYPOINT-then-args composition is handled by treating each
 *     directive line independently (Dockerfile semantics — ENTRYPOINT exec
 *     form with CMD exec form *concatenates* args, but the same port-flag
 *     pattern is what we look for in either line).
 *
 * Pure function: input → output. No I/O. Safe to test with zero deps.
 */

export interface PortFixResult {
  /** Whether the Dockerfile content changed */
  changed: boolean;
  /** New Dockerfile content (=== input if unchanged, modulo no whitespace
   *  rewrites — we never strip/add lines, only swap the matched directive). */
  next: string;
  /** Human-readable summary of what we changed (or why we didn't). */
  reason: string;
  /** Original ports we replaced, if any (for logging / surface to user). */
  replacedPorts?: number[];
}

// Regex compiled once. Match "CMD" or "ENTRYPOINT" + JSON-array exec form.
// Permissive on whitespace; the array literal goes from `[` to the last `]`
// on the same line. We don't try to handle multi-line JSON arrays — those
// are vanishingly rare in real Dockerfiles and a multi-line tokenizer is
// overkill for the bug we're fixing.
const DIRECTIVE_RE = /^(\s*)(CMD|ENTRYPOINT)\s+(\[.+\])\s*$/;

// A port literal: 3-5 digits, no leading zero. Tightening to common range
// (well-known ports up to ephemeral) keeps us from rewriting random numeric
// args that aren't actually ports.
const PORT_LITERAL_RE = /^[1-9][0-9]{2,4}$/;

// host:port — capture both groups.
const HOST_PORT_RE = /^([^:\s]+):([1-9][0-9]{2,4})$/;

// Already an env-var reference (any of $PORT, ${PORT}, ${PORT:-N}). We
// don't replace these literals (they're already trying to do the right
// thing), but their presence still triggers the sh -c wrapper because exec
// form won't expand them.
const PORT_ENV_RE = /\$\{?PORT(?::-?[0-9]+)?\}?/;

interface PortHit {
  /** Index of the first arg this hit covers. */
  argIndex: number;
  /** How many original args this hit consumes (replaces). 1 for equals/positional
   *  forms, 2 for separate flag+value (`--port N`). */
  consumesCount: number;
  /** Original port number we're replacing. */
  port: number;
  /** Builder that returns the REPLACEMENT TOKEN ARRAY (length need not equal
   *  consumesCount — but in practice it does). Each returned token represents
   *  a single shell argument; tokens are quoted independently downstream so
   *  multi-token forms like `--port`+`${PORT:-N}` round-trip correctly. */
  buildReplacement: (envExpr: string) => string[];
}

/**
 * Scan an arg array for a recognizable hardcoded port. Returns the FIRST
 * hit (Dockerfiles have exactly one launch invocation per directive in
 * practice; if there were two we wouldn't know which is the real port).
 */
function findHardcodedPort(args: string[]): PortHit | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    // Form 1: `--port=N`, `-p=N`, `--listen=N`
    const equalsMatch = a.match(/^(--port|--listen|-p)=([1-9][0-9]{2,4})$/);
    if (equalsMatch) {
      const flag = equalsMatch[1];
      const port = parseInt(equalsMatch[2], 10);
      return {
        argIndex: i,
        consumesCount: 1,
        port,
        buildReplacement: (env) => [`${flag}=${env}`],
      };
    }

    // Form 2: `--bind=H:N` or `-b=H:N`
    const bindEqMatch = a.match(/^(--bind|-b)=([^:\s]+):([1-9][0-9]{2,4})$/);
    if (bindEqMatch) {
      const flag = bindEqMatch[1];
      const host = bindEqMatch[2];
      const port = parseInt(bindEqMatch[3], 10);
      return {
        argIndex: i,
        consumesCount: 1,
        port,
        buildReplacement: (env) => [`${flag}=${host}:${env}`],
      };
    }

    // Form 3: `--port N` / `-p N` / `--listen N` (next arg is value)
    if ((a === '--port' || a === '-p' || a === '--listen') && i + 1 < args.length) {
      const next = args[i + 1];
      if (PORT_LITERAL_RE.test(next)) {
        const port = parseInt(next, 10);
        return {
          argIndex: i,
          consumesCount: 2,
          port,
          buildReplacement: (env) => [a, env],
        };
      }
    }

    // Form 4: `--bind H:N` or `-b H:N`
    if ((a === '--bind' || a === '-b') && i + 1 < args.length) {
      const next = args[i + 1];
      const hp = next.match(HOST_PORT_RE);
      if (hp) {
        const host = hp[1];
        const port = parseInt(hp[2], 10);
        return {
          argIndex: i,
          consumesCount: 2,
          port,
          buildReplacement: (env) => [a, `${host}:${env}`],
        };
      }
    }

    // Form 5: positional `H:N` directly after `runserver` / `server` (django,
    // rails). Require previous arg to be that token to avoid matching random
    // urls.
    const positional = a.match(HOST_PORT_RE);
    if (positional && i > 0) {
      const prev = args[i - 1];
      if (prev === 'runserver' || prev === 'server') {
        const host = positional[1];
        const port = parseInt(positional[2], 10);
        return {
          argIndex: i,
          consumesCount: 1,
          port,
          buildReplacement: (env) => [`${host}:${env}`],
        };
      }
    }
  }
  return null;
}

/**
 * Try to fix a single CMD/ENTRYPOINT line. Returns:
 *   - { fixed, port } if we rewrote it
 *   - null if no fix is needed (already shell form, no recognizable port,
 *     unparseable JSON, etc.)
 */
function fixDirectiveLine(line: string): { fixed: string; port: number } | null {
  const m = line.match(DIRECTIVE_RE);
  if (!m) return null;

  const [, indent, directive, jsonArr] = m;

  let args: unknown;
  try {
    args = JSON.parse(jsonArr);
  } catch {
    return null;
  }
  if (!Array.isArray(args) || !args.every((x) => typeof x === 'string')) return null;
  const strArgs = args as string[];
  if (strArgs.length === 0) return null;

  // Idempotency: already shell form (sh / bash -c). Note: we deliberately
  // don't try to detect-and-fix nested cases like ["sh", "-c", "uvicorn ...
  // --port 8080"] — if the user wrote sh -c they own the shell content.
  const first = strArgs[0];
  if (
    first === 'sh' ||
    first === 'bash' ||
    first === '/bin/sh' ||
    first === '/bin/bash' ||
    first === 'ash' ||
    first === '/bin/ash'
  ) {
    return null;
  }

  // Two trigger conditions:
  //   (a) any arg already references PORT — exec form leaks variable
  //   (b) we found a hardcoded port pattern we can rewrite
  const hasVarLeak = strArgs.some((a) => PORT_ENV_RE.test(a));
  const hit = findHardcodedPort(strArgs);

  if (!hasVarLeak && !hit) return null;

  // Build the new args array.
  let newArgs: string[];
  let port: number;
  if (hit) {
    port = hit.port;
    const env = `\${PORT:-${port}}`;
    const replacement = hit.buildReplacement(env);
    newArgs = [
      ...strArgs.slice(0, hit.argIndex),
      ...replacement,
      ...strArgs.slice(hit.argIndex + hit.consumesCount),
    ];
  } else {
    // hasVarLeak only: keep args verbatim, just need the sh -c wrapper so
    // the existing ${PORT...} actually expands.
    newArgs = strArgs;
    port = 8080; // unknown — pick Cloud Run default for the reason field
  }

  // Join into a single shell command. We need to re-quote any arg that
  // contains shell-significant characters; the simplest correct
  // approximation is to single-quote anything with whitespace or shell
  // metas, but most uvicorn/gunicorn launch lines are clean tokens.
  // For safety we only single-quote args that NEED it; bare tokens stay
  // bare so the resulting line stays human-readable.
  const shellCmd = newArgs.map(shellQuoteIfNeeded).join(' ');

  return {
    fixed: `${indent}${directive} ["sh", "-c", ${JSON.stringify(shellCmd)}]`,
    port,
  };
}

/**
 * Quote an arg for inclusion in a shell command line. We single-quote when
 * an arg contains whitespace or shell metas; otherwise leave it bare. We
 * deliberately do NOT touch strings containing `$` so that `${PORT:-8000}`
 * keeps its expansion semantics inside the resulting `sh -c` payload.
 */
function shellQuoteIfNeeded(arg: string): string {
  // Whitespace, semicolon, ampersand, pipe, redirects, parens, backticks —
  // anything that would change shell parsing if left bare.
  if (/[\s;&|<>()`]/.test(arg)) {
    // Single-quote and escape any embedded single quotes (POSIX trick).
    return `'${arg.replace(/'/g, `'\\''`)}'`;
  }
  return arg;
}

/**
 * Fix all CMD / ENTRYPOINT lines in a Dockerfile. Idempotent: running it
 * twice on the same input yields the same output (since the second run sees
 * `sh -c` as the first arg and short-circuits).
 *
 * Pure function: takes a Dockerfile string, returns the new string + a
 * summary. Never throws on malformed input — returns changed=false instead.
 */
export function fixDockerfilePorts(content: string): PortFixResult {
  if (typeof content !== 'string') {
    return { changed: false, next: '', reason: 'invalid input: content not a string' };
  }

  const lines = content.split('\n');
  const replacedPorts: number[] = [];
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const result = fixDirectiveLine(lines[i]);
    if (result) {
      lines[i] = result.fixed;
      replacedPorts.push(result.port);
      changed = true;
    }
  }

  if (!changed) {
    return {
      changed: false,
      next: content,
      reason: 'no CMD/ENTRYPOINT line needed port fix',
    };
  }

  const portList = replacedPorts.join(', ');
  return {
    changed: true,
    next: lines.join('\n'),
    reason: `wrapped ${replacedPorts.length} directive(s) in sh -c with \${PORT:-N} (was: ${portList})`,
    replacedPorts,
  };
}
