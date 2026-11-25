/**
 * scripts/init-schema.ts — DDICBot Neon schema (P1T2, task t_90f1f113)
 *
 * Creates the three core tables (drugs, ddi_pairs, drug_names) and the three
 * named indexes (GIN pg_trgm on surface names and canonical English names,
 * composite on the pair columns), exactly as specified in the task contract.
 * Every statement is idempotent (IF NOT EXISTS), so the script is safe to
 * re-run at any time.
 *
 * Usage:
 *   npx tsx scripts/init-schema.ts
 *
 * DSN resolution: $NEON_DATABASE_URL first, then NEON_DATABASE_URL from the
 * repo .env (gitignored; the DSN is never printed). Target: Neon project
 * late-paper-56442720, branch br-aged-salad-birsqdh2, pooled endpoint, role
 * neondb_owner, db neondb, PG 18.7, ap-southeast-1. pg_trgm and
 * fuzzystrmatch are pre-enabled on the branch.
 *
 * Fails loudly: the whole DDL runs in one transaction; the first failing
 * statement rolls it back and aborts the run with the full error — no
 * partial schemas, no silent skips.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function resolveDsn(): string {
  const fromEnv = process.env.NEON_DATABASE_URL;
  if (fromEnv) return fromEnv;
  let envFile: string;
  try {
    envFile = readFileSync(join(root, ".env"), "utf8");
  } catch (err) {
    throw new Error(
      `NEON_DATABASE_URL is not set and the repo .env could not be read: ${String(err)}`,
    );
  }
  for (const line of envFile.split("\n")) {
    const m = line.match(/^NEON_DATABASE_URL="?([^"\r\n]+)"?$/);
    if (m) return m[1];
  }
  throw new Error("NEON_DATABASE_URL not found in process env or repo .env");
}

// Exactly the contract DDL (t_90f1f113). All statements are idempotent.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS drugs (
  id SERIAL PRIMARY KEY,
  ingredient_id TEXT UNIQUE NOT NULL,
  canonical_en TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS ddi_pairs (
  id BIGSERIAL PRIMARY KEY,
  drug_a_ingredient TEXT NOT NULL,
  drug_b_ingredient TEXT NOT NULL,
  severity TEXT CHECK (severity IN ('Major','Moderate','Minor','Unknown')),
  mechanism_en TEXT,
  source TEXT DEFAULT 'DDInter 2.0',
  UNIQUE (drug_a_ingredient, drug_b_ingredient)
)`,
  `CREATE TABLE IF NOT EXISTS drug_names (
  id SERIAL PRIMARY KEY,
  ingredient_id TEXT NOT NULL REFERENCES drugs(ingredient_id),
  surface_name TEXT NOT NULL,
  lang TEXT NOT NULL CHECK (lang IN ('en','zh','ja')),
  source TEXT DEFAULT 'RxNorm/PubChem'
)`,
  `CREATE INDEX IF NOT EXISTS idx_drug_names_trgm ON drug_names USING GIN (surface_name gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_drugs_canonical_trgm ON drugs USING GIN (canonical_en gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_ddi_pairs_ab ON ddi_pairs (drug_a_ingredient, drug_b_ingredient)`,
];

// The PgBouncer pooled endpoint occasionally drops a connection mid-session;
// retry the whole run a bounded number of times on connection-level failures
// only. SQL errors roll back the transaction and abort immediately.
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2000;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const client = new pg.Client({ connectionString: resolveDsn() });
  try {
    await client.connect();
    for (const [i, stmt] of STATEMENTS.entries()) {
      const label = stmt.split("\n").find((l) => l.trim().length > 0) ?? "";
      if (i === 0) await client.query("BEGIN");
      try {
        await client.query(stmt);
        console.log(`[${i + 1}/${STATEMENTS.length}] OK   ${label.trim()}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[${i + 1}/${STATEMENTS.length}] FAIL ${label.trim()}`);
        console.error(err instanceof Error ? err.stack : String(err));
        throw err;
      }
    }
    await client.query("COMMIT");
    console.log("schema: all 3 tables + 3 named indexes present (created or kept)");
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const connectionLevel =
      /connection|terminated|socket|ECONN/i.test(message) &&
      !/ROLLBACK|FAIL/.test(message) &&
      !(err instanceof Error && (err as Error & { code?: string }).code?.startsWith("4"));
    if (!connectionLevel || attempt === MAX_ATTEMPTS) throw err;
    console.error(`attempt ${attempt}: connection dropped (${message}); retrying...`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  } finally {
    await client.end().catch(() => {});
  }
}
