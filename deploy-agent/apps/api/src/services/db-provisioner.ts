/**
 * Database Provisioner — creates per-project databases and users on the shared Cloud SQL instance.
 *
 * Architecture:
 *   One Cloud SQL instance (deploy-agent-db) shared by all projects.
 *   Each project gets its own database + dedicated user with limited privileges.
 */

import { Pool } from 'pg';
import crypto from 'node:crypto';

export interface ProvisionResult {
  dbName: string;
  dbUser: string;
  dbPassword: string;
  connectionString: string;  // Full DATABASE_URL for the project
  created: boolean;          // true if newly created, false if already existed
}

/**
 * Provision a database + user for a project on the shared Cloud SQL instance.
 * Idempotent: if the database/user already exist, returns existing credentials.
 */
export async function provisionProjectDatabase(
  projectSlug: string,
  gcpProject: string,
  gcpRegion: string,
): Promise<ProvisionResult> {
  // Sanitize slug for use as DB/user name (only lowercase alphanumeric + underscore)
  const safeName = projectSlug.replace(/[^a-z0-9]/g, '_').slice(0, 50);
  const dbName = `proj_${safeName}`;
  const dbUser = `user_${safeName}`;
  const instanceConnectionName = `${gcpProject}:${gcpRegion}:deploy-agent-db`;

  // Connect to the shared instance using the admin credentials
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error('DATABASE_URL (admin) is not set — cannot provision project databases');
  }

  const pool = new Pool({
    connectionString: adminUrl,
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  try {
    const client = await pool.connect();
    try {
      // 1. Check if database already exists
      const dbCheck = await client.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName]
      );

      let password: string;
      let created = false;

      if (dbCheck.rows.length > 0) {
        // Database exists — check if we have the password stored
        // We store provisioned credentials in a metadata table
        const credCheck = await client.query(
          `SELECT password FROM project_db_credentials WHERE db_name = $1`,
          [dbName]
        );
        if (credCheck.rows.length > 0) {
          password = credCheck.rows[0].password;
          console.log(`[DB] Database ${dbName} already exists, reusing credentials`);
        } else {
          // DB exists but no stored credential — generate new password and reset
          password = crypto.randomBytes(24).toString('base64url');
          await client.query(`ALTER ROLE "${dbUser}" WITH PASSWORD '${escapePassword(password)}'`);
          await ensureCredentialsTable(client);
          await client.query(
            `INSERT INTO project_db_credentials (db_name, db_user, password) VALUES ($1, $2, $3)
             ON CONFLICT (db_name) DO UPDATE SET password = $3, updated_at = NOW()`,
            [dbName, dbUser, password]
          );
          console.log(`[DB] Database ${dbName} exists, reset password for user ${dbUser}`);
        }
      } else {
        // 2. Create new database + user
        password = crypto.randomBytes(24).toString('base64url');
        created = true;

        // Create user (role)
        const userCheck = await client.query(
          `SELECT 1 FROM pg_roles WHERE rolname = $1`,
          [dbUser]
        );
        if (userCheck.rows.length === 0) {
          await client.query(`CREATE ROLE "${dbUser}" WITH LOGIN PASSWORD '${escapePassword(password)}'`);
          console.log(`[DB] Created user: ${dbUser}`);
        } else {
          // User exists but DB doesn't — reset password
          await client.query(`ALTER ROLE "${dbUser}" WITH PASSWORD '${escapePassword(password)}'`);
          console.log(`[DB] User ${dbUser} exists, reset password`);
        }

        // Grant the new role to the current (admin) user so we can set OWNER
        // PostgreSQL requires membership in the target role to assign ownership
        const currentUser = (await client.query(`SELECT current_user`)).rows[0].current_user;
        await client.query(`GRANT "${dbUser}" TO "${currentUser}"`);

        // Create database owned by the new user
        await client.query(`CREATE DATABASE "${dbName}" OWNER "${dbUser}"`);
        console.log(`[DB] Created database: ${dbName}`);

        // Store credentials
        await ensureCredentialsTable(client);
        await client.query(
          `INSERT INTO project_db_credentials (db_name, db_user, password) VALUES ($1, $2, $3)
           ON CONFLICT (db_name) DO UPDATE SET password = $3, updated_at = NOW()`,
          [dbName, dbUser, password]
        );
      }

      // Build connection string using Cloud SQL socket
      const connectionString =
        `postgresql://${dbUser}:${encodeURIComponent(password)}@/${dbName}?host=/cloudsql/${instanceConnectionName}`;

      return {
        dbName,
        dbUser,
        dbPassword: password,
        connectionString,
        created,
      };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** Ensure the credentials metadata table exists */
async function ensureCredentialsTable(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS project_db_credentials (
      db_name VARCHAR(100) PRIMARY KEY,
      db_user VARCHAR(100) NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Escape single quotes in password for SQL */
function escapePassword(pw: string): string {
  return pw.replace(/'/g, "''");
}
