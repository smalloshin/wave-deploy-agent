/**
 * Tests: dockerfile-port-fixer (R46 — auto-fix Cloud Run PORT mismatch)
 *
 * Why this matters:
 *   - luca-optimizer-kb canonical case: hand-written Dockerfile hardcoded
 *     `--port 8080`, Cloud Run revision wants PORT=8000, container started
 *     but health check probed wrong port → deploy failed after ~4 min with
 *     "container failed to start and listen on the port defined provided
 *     by the PORT environment variable within the allocated timeout".
 *   - Our own dockerfile-gen had the same class of bug pre-R46: exec form
 *     `CMD ["uvicorn", ..., "--port", "${PORT:-8000}"]` looks correct but
 *     Docker exec form does NOT spawn a shell, so `${PORT:-8000}` is passed
 *     to uvicorn as a literal 13-char string. (Fixed in dockerfile-gen.ts
 *     same round.)
 *   - Both failure modes are mechanical patterns and worth a deterministic
 *     fixer (versus an LLM rule) — no latency, perfect repeatability,
 *     fully testable.
 *
 * What we lock in:
 *   - All recognized port-flag forms (--port N, --port=N, -p N, --bind H:N,
 *     -b H:N, equals variants, positional H:N after `runserver`/`server`).
 *   - Only KNOWN port positions are rewritten — we never touch random ints.
 *   - sh -c / bash -c / /bin/sh form is left alone (idempotency).
 *   - CMD with no recognizable port flag is left alone (don't break Node
 *     CMD ["node", "server.js"] case where port is in code).
 *   - Exec-form variable leak (any ${PORT...} in args) triggers sh -c wrap
 *     even when no hardcoded literal is present.
 *   - Idempotency: running twice yields same output.
 *   - Defensive: malformed JSON, non-string args, empty array all return
 *     changed=false.
 *
 * Run: bun run src/test-dockerfile-port-fixer.ts
 */

import assert from 'node:assert/strict';
import { fixDockerfilePorts } from './services/dockerfile-port-fixer';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

console.log('\n=== dockerfile-port-fixer.fixDockerfilePorts ===\n');

// ───────────────────── canonical case: luca-optimizer-kb ─────────────────────

test('luca-optimizer-kb canonical: uvicorn hardcoded --port 8080 → sh -c with ${PORT:-8080}', () => {
  const input = [
    'FROM python:3.12-slim',
    'WORKDIR /app',
    'COPY . .',
    'RUN pip install -r requirements.txt',
    '# Use a standard CMD for uvicorn. The PORT env var will be respected by uvicorn.',
    'CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]',
  ].join('\n');
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, true);
  assert.deepEqual(r.replacedPorts, [8080]);
  assert.match(
    r.next,
    /CMD \["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port \$\{PORT:-8080\}"\]/,
  );
  // Other lines untouched.
  assert.match(r.next, /^FROM python:3\.12-slim/m);
  assert.match(r.next, /^RUN pip install -r requirements.txt$/m);
});

// ───────────────────── recognized port-flag forms ─────────────────────

test('uvicorn --port 8000 (separate value)', () => {
  const r = fixDockerfilePorts(`CMD ["uvicorn", "app:app", "--port", "8000"]`);
  assert.equal(r.changed, true);
  assert.deepEqual(r.replacedPorts, [8000]);
  assert.match(r.next, /CMD \["sh", "-c", "uvicorn app:app --port \$\{PORT:-8000\}"\]/);
});

test('uvicorn --port=8000 (equals form)', () => {
  const r = fixDockerfilePorts(`CMD ["uvicorn", "app:app", "--port=8000"]`);
  assert.equal(r.changed, true);
  assert.deepEqual(r.replacedPorts, [8000]);
  assert.match(r.next, /CMD \["sh", "-c", "uvicorn app:app --port=\$\{PORT:-8000\}"\]/);
});

test('flask -p 5000 (short flag)', () => {
  const r = fixDockerfilePorts(`CMD ["flask", "run", "-p", "5000"]`);
  assert.equal(r.changed, true);
  assert.deepEqual(r.replacedPorts, [5000]);
  assert.match(r.next, /"flask run -p \$\{PORT:-5000\}"/);
});

test('gunicorn --bind 0.0.0.0:8000 (bind separate value)', () => {
  const r = fixDockerfilePorts(`CMD ["gunicorn", "--bind", "0.0.0.0:8000", "app:app"]`);
  assert.equal(r.changed, true);
  assert.deepEqual(r.replacedPorts, [8000]);
  assert.match(r.next, /"gunicorn --bind 0.0.0.0:\$\{PORT:-8000\} app:app"/);
});

test('gunicorn -b 0.0.0.0:5000 (short bind separate value)', () => {
  const r = fixDockerfilePorts(`CMD ["gunicorn", "-b", "0.0.0.0:5000", "app:app"]`);
  assert.equal(r.changed, true);
  assert.deepEqual(r.replacedPorts, [5000]);
  assert.match(r.next, /"gunicorn -b 0.0.0.0:\$\{PORT:-5000\} app:app"/);
});

test('gunicorn --bind=0.0.0.0:8000 (bind equals form)', () => {
  const r = fixDockerfilePorts(`CMD ["gunicorn", "--bind=0.0.0.0:8000", "app:app"]`);
  assert.equal(r.changed, true);
  assert.deepEqual(r.replacedPorts, [8000]);
  assert.match(r.next, /CMD \["sh", "-c", "gunicorn --bind=0.0.0.0:\$\{PORT:-8000\} app:app"\]/);
});

test('django manage.py runserver 0.0.0.0:8000 (positional host:port after runserver)', () => {
  const r = fixDockerfilePorts(
    `CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]`,
  );
  assert.equal(r.changed, true);
  assert.deepEqual(r.replacedPorts, [8000]);
  assert.match(
    r.next,
    /CMD \["sh", "-c", "python manage.py runserver 0.0.0.0:\$\{PORT:-8000\}"\]/,
  );
});

test('rails server -b 0.0.0.0 -p 3000 (short port flag)', () => {
  const r = fixDockerfilePorts(
    `CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "3000"]`,
  );
  assert.equal(r.changed, true);
  // -b 0.0.0.0 doesn't match (not host:port), so we'll hit -p 3000 instead.
  assert.deepEqual(r.replacedPorts, [3000]);
  assert.match(r.next, /-p \$\{PORT:-3000\}/);
});

test('ENTRYPOINT also handled (not just CMD)', () => {
  const r = fixDockerfilePorts(`ENTRYPOINT ["uvicorn", "app:app", "--port", "8080"]`);
  assert.equal(r.changed, true);
  assert.deepEqual(r.replacedPorts, [8080]);
  assert.match(r.next, /ENTRYPOINT \["sh", "-c", "uvicorn app:app --port \$\{PORT:-8080\}"\]/);
});

// ───────────────────── exec form variable leak ─────────────────────

test('exec form ${PORT:-8000} leak (our pre-R46 auto-gen bug) → sh -c wrap', () => {
  const input = `CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "\${PORT:-8000}"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, true);
  // Both args (--port and ${PORT:-8000}) are preserved verbatim, just wrapped.
  assert.match(
    r.next,
    /CMD \["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port \$\{PORT:-8000\}"\]/,
  );
});

test('exec form bare $PORT also triggers sh -c wrap', () => {
  const input = `CMD ["python", "main.py", "$PORT"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, true);
  assert.match(r.next, /CMD \["sh", "-c", "python main.py \$PORT"\]/);
});

test('exec form ${PORT} (no default) triggers sh -c wrap', () => {
  const input = `CMD ["python", "main.py", "\${PORT}"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, true);
  assert.match(r.next, /CMD \["sh", "-c", "python main.py \$\{PORT\}"\]/);
});

// ───────────────────── idempotency / no-op cases ─────────────────────

test('idempotent: running fixer twice yields same result', () => {
  const input = `CMD ["uvicorn", "app:app", "--port", "8080"]`;
  const r1 = fixDockerfilePorts(input);
  assert.equal(r1.changed, true);
  const r2 = fixDockerfilePorts(r1.next);
  assert.equal(r2.changed, false);
  assert.equal(r2.next, r1.next);
});

test('sh -c form left untouched (already correct)', () => {
  const input = `CMD ["sh", "-c", "uvicorn app:app --port \${PORT:-8000}"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
  assert.equal(r.next, input);
});

test('bash -c form left untouched', () => {
  const input = `CMD ["bash", "-c", "node server.js"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
});

test('/bin/sh -c form left untouched', () => {
  const input = `CMD ["/bin/sh", "-c", "uvicorn app:app --port \${PORT:-8000}"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
});

test('CMD ["node", "server.js"] left alone — port lives in code', () => {
  const input = `CMD ["node", "server.js"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
  assert.equal(r.next, input);
});

test('CMD ["node", "server.js"] with EXPOSE 8080 still left alone', () => {
  const input = ['EXPOSE 8080', 'CMD ["node", "server.js"]'].join('\n');
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
});

test('shell-form CMD (no JSON array) left alone', () => {
  const input = `CMD uvicorn app:app --port \${PORT:-8000}`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
});

test('CMD with random integer not adjacent to port flag is NOT rewritten', () => {
  // 12345 here is a positional arg meaning something else (e.g. delay seconds).
  const input = `CMD ["my-cli", "--retries", "3", "12345"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
});

test('positional H:P NOT after runserver/server is NOT rewritten', () => {
  // could be a URL component, not a launch port. Be conservative.
  const input = `CMD ["my-cli", "--target", "10.0.0.1:8000"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
});

// ───────────────────── defensive cases ─────────────────────

test('malformed JSON in CMD → changed=false, content untouched', () => {
  const input = `CMD ["uvicorn", "app:app", --port, "8000"]`; // unquoted --port
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
  assert.equal(r.next, input);
});

test('non-string element in JSON array → changed=false', () => {
  const input = `CMD ["uvicorn", "app:app", "--port", 8000]`; // 8000 not a string
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
});

test('empty CMD array → changed=false', () => {
  const input = `CMD []`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, false);
});

test('non-string content input → changed=false, no throw', () => {
  // @ts-expect-error testing defensive guard
  const r = fixDockerfilePorts(null);
  assert.equal(r.changed, false);
});

test('preserves leading whitespace on CMD line', () => {
  const input = `    CMD ["uvicorn", "app:app", "--port", "8000"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, true);
  assert.match(r.next, /^    CMD \["sh", "-c",/m);
});

test('multiple CMD lines (uncommon but technically legal): both rewritten', () => {
  // Docker only honors the LAST CMD, but we shouldn't crash on multiples.
  const input = [
    'CMD ["uvicorn", "app:app", "--port", "8080"]',
    'CMD ["uvicorn", "app:app", "--port", "9000"]',
  ].join('\n');
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, true);
  assert.deepEqual(r.replacedPorts, [8080, 9000]);
});

// ───────────────────── full Dockerfile passthrough ─────────────────────

test('full multi-line Dockerfile: only CMD line changed, all else identical', () => {
  const input = [
    'FROM python:3.12-slim',
    'WORKDIR /app',
    '',
    '# install deps',
    'COPY requirements.txt ./',
    'RUN pip install -r requirements.txt',
    '',
    'COPY . .',
    'ENV PORT=8000',
    'EXPOSE 8000',
    'CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]',
  ].join('\n');
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, true);

  const inLines = input.split('\n');
  const outLines = r.next.split('\n');
  assert.equal(outLines.length, inLines.length);
  for (let i = 0; i < inLines.length - 1; i++) {
    assert.equal(outLines[i], inLines[i], `line ${i + 1} should be unchanged`);
  }
  // Only the last line (CMD) changed.
  assert.notEqual(outLines[outLines.length - 1], inLines[inLines.length - 1]);
});

test('reason string includes original port for log readability', () => {
  const r = fixDockerfilePorts(`CMD ["uvicorn", "app:app", "--port", "8080"]`);
  assert.equal(r.changed, true);
  assert.match(r.reason, /was: 8080/);
});

test('shell-quotes args containing whitespace inside the sh -c payload', () => {
  // Args with whitespace would tokenize differently inside sh -c if left bare.
  const input = `CMD ["uvicorn", "module with space:app", "--port", "8000"]`;
  const r = fixDockerfilePorts(input);
  assert.equal(r.changed, true);
  // The whitespace arg should be single-quoted in the shell payload.
  assert.match(r.next, /'module with space:app'/);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
