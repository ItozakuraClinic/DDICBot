/**
 * Run db/schema.sql against the Neon database.
 *
 * Usage:
 *   node db/migrate.ts            (needs NEON_DATABASE_URL in env)
 *
 * Reads the SQL file, splits it into statements, applies each one to the
 * same connection, and logs the outcome per statement.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const databaseUrl = process.env.NEON_DATABASE_URL;
if (!databaseUrl) {
  console.error('NEON_DATABASE_URL is not set');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, 'schema.sql'), 'utf8');

// Split on top-level semicolons. The schema file contains no semicolons
// inside string literals or dollar-quoted bodies, so a plain split is safe.
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith('--'));

const client = new pg.Client({ connectionString: databaseUrl });

async function main(): Promise<void> {
  try {
    await client.connect();
    for (const [i, stmt] of statements.entries()) {
      const firstLine = stmt.split('\n').find((l) => l.trim().length > 0) ?? '';
      try {
        const result = await client.query(stmt);
        const rowCount = result.rowCount?.toString() ?? '?';
        console.log(`[${i + 1}/${statements.length}] OK   ${firstLine.trim()} (rows: ${rowCount})`);
      } catch (err) {
        console.error(`[${i + 1}/${statements.length}] FAIL ${firstLine.trim()}`);
        console.error(`       ${String(err)}`);
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  console.log('migrate: done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
