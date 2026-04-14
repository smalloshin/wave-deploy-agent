import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run all migrations (idempotent — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 * Can be called from API startup or as a standalone script.
 */
export async function runMigrations(): Promise<void> {
  console.log('Running database migrations...');
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
    console.log('Migrations completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Allow running as standalone script: `npx tsx src/db/migrate.ts`
const isMain = process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js');
if (isMain) {
  runMigrations()
    .then(() => { pool.end(); process.exit(0); })
    .catch(() => { pool.end(); process.exit(1); });
}
