/**
 * Database Restore — restores user-provided SQL dumps into project databases.
 *
 * Supports:
 *   - Plain SQL dumps (.sql) via `psql`
 *   - Custom-format dumps (.dump) via `pg_restore`
 *   - Compressed SQL (.sql.gz) via `gunzip | psql`
 *
 * Security:
 *   - Each project has its own database + user (from db-provisioner)
 *   - The restore runs with the project's limited-privilege user, NOT admin
 *   - Even if the dump contains malicious SQL (DROP DATABASE, etc.), it can only
 *     affect the project's own database
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';

const execFileAsync = promisify(execFile);

export interface RestoreConfig {
  /** Path to the dump file on disk */
  dumpFilePath: string;
  /** PostgreSQL connection string for the project's database */
  connectionString: string;
  /** Cloud SQL instance connection name (for socket path) */
  instanceConnectionName: string;
}

export interface RestoreResult {
  success: boolean;
  durationMs: number;
  bytesRestored: number;
  error: string | null;
  format: 'sql' | 'custom' | 'sql_gz' | 'unknown';
}

/**
 * Detect dump file format from extension and magic bytes.
 */
function detectFormat(filePath: string): RestoreResult['format'] {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.sql.gz')) return 'sql_gz';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.dump') || lower.endsWith('.pgdump')) return 'custom';

  // Check magic bytes for pg_dump custom format (starts with "PGDMP")
  try {
    const { readFileSync } = require('node:fs');
    const buf = readFileSync(filePath, { encoding: null, flag: 'r' });
    if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === 'PGDMP') {
      return 'custom';
    }
  } catch { /* ignore */ }

  return 'unknown';
}

/**
 * Parse a DATABASE_URL with Cloud SQL socket into psql-compatible env vars.
 *
 * Input:  postgresql://user:pass@/dbname?host=/cloudsql/project:region:instance
 * Output: { PGUSER, PGPASSWORD, PGDATABASE, PGHOST }
 */
function parseConnectionString(connStr: string): Record<string, string> {
  const url = new URL(connStr);
  const env: Record<string, string> = {};

  env.PGUSER = decodeURIComponent(url.username);
  env.PGPASSWORD = decodeURIComponent(url.password);
  // Database name: path after /
  env.PGDATABASE = url.pathname.replace(/^\//, '');
  // Host: from ?host= query param (Cloud SQL socket path)
  const host = url.searchParams.get('host');
  if (host) {
    env.PGHOST = host;
  } else if (url.hostname && url.hostname !== 'localhost' && url.hostname !== '') {
    env.PGHOST = url.hostname;
    if (url.port) env.PGPORT = url.port;
  }

  return env;
}

/**
 * Restore a database dump into the project's Cloud SQL database.
 * Uses the project's limited-privilege user — cannot affect other databases.
 */
export async function restoreDbDump(config: RestoreConfig): Promise<RestoreResult> {
  const start = Date.now();
  const format = detectFormat(config.dumpFilePath);

  if (!existsSync(config.dumpFilePath)) {
    return {
      success: false,
      durationMs: Date.now() - start,
      bytesRestored: 0,
      error: `Dump file not found: ${config.dumpFilePath}`,
      format,
    };
  }

  const fileSize = statSync(config.dumpFilePath).size;
  const pgEnv = parseConnectionString(config.connectionString);

  // Merge with process env (keep PATH etc.) but override PG* vars
  const env = { ...process.env, ...pgEnv };

  console.log(`[DB-Restore] Format: ${format}, size: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[DB-Restore] Target: ${pgEnv.PGDATABASE} (user: ${pgEnv.PGUSER})`);

  try {
    switch (format) {
      case 'sql': {
        // Plain SQL: psql -f dump.sql
        const { stdout, stderr } = await execFileAsync(
          'psql',
          ['-f', config.dumpFilePath, '--no-psqlrc', '-v', 'ON_ERROR_STOP=0'],
          { env, timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 }
        );
        if (stderr) {
          // psql writes notices to stderr — filter out real errors
          const errors = stderr.split('\n').filter(l =>
            l.includes('ERROR') || l.includes('FATAL')
          );
          if (errors.length > 0) {
            console.warn(`[DB-Restore] psql warnings/errors:\n${errors.slice(0, 10).join('\n')}`);
          }
        }
        console.log(`[DB-Restore] psql completed (${stdout.split('\n').length} lines of output)`);
        break;
      }

      case 'custom': {
        // Custom format: pg_restore -d dbname dump.dump
        // --no-owner: ignore ownership commands (we use our own user)
        // --no-privileges: skip GRANT/REVOKE
        // --if-exists: don't fail on DROP IF EXISTS
        const { stderr } = await execFileAsync(
          'pg_restore',
          [
            '--no-owner',
            '--no-privileges',
            '--if-exists',
            '--clean',     // DROP before CREATE
            '-d', pgEnv.PGDATABASE,
            config.dumpFilePath,
          ],
          { env, timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 }
        );
        if (stderr) {
          const errors = stderr.split('\n').filter(l =>
            l.includes('ERROR') || l.includes('FATAL')
          );
          if (errors.length > 0) {
            console.warn(`[DB-Restore] pg_restore warnings:\n${errors.slice(0, 10).join('\n')}`);
          }
        }
        console.log(`[DB-Restore] pg_restore completed`);
        break;
      }

      case 'sql_gz': {
        // Compressed SQL: gunzip -c dump.sql.gz | psql
        // Use shell pipeline via bash -c
        const { execFile: execFileCb } = await import('node:child_process');
        const { promisify: p } = await import('node:util');
        const exec = p(execFileCb);
        const { stderr } = await exec(
          'bash',
          ['-c', `gunzip -c "${config.dumpFilePath}" | psql --no-psqlrc -v ON_ERROR_STOP=0`],
          { env, timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 }
        );
        if (stderr) {
          const errors = stderr.split('\n').filter(l =>
            l.includes('ERROR') || l.includes('FATAL')
          );
          if (errors.length > 0) {
            console.warn(`[DB-Restore] gunzip|psql warnings:\n${errors.slice(0, 10).join('\n')}`);
          }
        }
        console.log(`[DB-Restore] gunzip|psql completed`);
        break;
      }

      default:
        return {
          success: false,
          durationMs: Date.now() - start,
          bytesRestored: fileSize,
          error: `Unsupported dump format. Please use .sql, .dump, .pgdump, or .sql.gz`,
          format,
        };
    }

    return {
      success: true,
      durationMs: Date.now() - start,
      bytesRestored: fileSize,
      error: null,
      format,
    };
  } catch (err) {
    const msg = (err as Error).message;
    // Truncate error message (pg_restore can be very verbose)
    const shortMsg = msg.length > 500 ? msg.slice(0, 500) + '...' : msg;
    console.error(`[DB-Restore] Failed: ${shortMsg}`);
    return {
      success: false,
      durationMs: Date.now() - start,
      bytesRestored: fileSize,
      error: shortMsg,
      format,
    };
  }
}
