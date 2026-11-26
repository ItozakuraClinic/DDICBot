/**
 * Applies db/schema.sql against NEON_DATABASE_URL.
 *
 * Usage:
 *   npx tsx db/migrate.ts
 *
 * Reads the DSN from the environment (via scripts/_load-env.ts which sources
 * ~/.hermes/.env when no local process env is set). Each statement is applied
 * on its own; the script is idempotent.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadHermesEnv } from "../scripts/_load-env.ts";

const url = process.env.NEON_DATABASE_URL || loadHermesEnv().NEON_DATABASE_URL;
if (!url) {
  console.error("NEON_DATABASE_URL is not set (env or ~/.hermes/.env)");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "schema.sql"), "utf8");

// Strip full-line comments before splitting, then split on top-level
// semicolons. No string literals in this schema contain ';', so the plain
// split is safe.
const sqlNoComments = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("#") && !l.trim().startsWith("--"))
  .join("\n");
const statements = sqlNoComments
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const client = new pg.Client({ connectionString: url });

let failed = false;
try {
  await client.connect();
  for (const [i, stmt] of statements.entries()) {
    const firstLine = stmt.split("\n").find((l) => l.trim().length > 0) ?? "";
    try {
      const result = await client.query(stmt);
      const rowCount = result.rowCount?.toString() ?? "?";
      console.log(`[${i + 1}/${statements.length}] OK   ${firstLine.trim()} (rows: ${rowCount})`);
    } catch (err) {
      failed = true;
      console.error(`[${i + 1}/${statements.length}] FAIL ${firstLine.trim()}`);
      console.error(`       ${String(err)}`);
      break;
    }
  }
} finally {
  await client.end();
}

// Report final state.
if (!failed) {
  const client2 = new pg.Client({ connectionString: url });
  try {
    await client2.connect();
    for (const t of ["drugs", "ddi_pairs", "drug_names", "chat_langs"]) {
      const r = await client2.query(`select count(*)::int as n from ${t}`);
      console.log(`${t} count: ${(r.rows[0] as { n: number }).n}`);
    }
    const idx = await client2.query(
      "select indexname from pg_indexes where schemaname='public' order by 1",
    );
    console.log("indexes:", idx.rows.map((r: { indexname: string }) => r.indexname).join(", "));
  } finally {
    await client2.end();
  }
  console.log("migrate: done");
} else {
  process.exit(1);
}
