import pg from "pg";

/**
 * Process-level pg pool for the DDICBot query core.
 *
 * The pooled Neon endpoint is connection-per-tenant; the pool keeps a small
 * set of reusable clients so webhook invocations don't pay a TCP+SSL+auth
 * handshake per query. In the Vercel nodejs runtime the pool lives for the
 * duration of the function instance and is torn down by the runtime exit.
 *
 * DSN comes from lib/env.ts (process env only — the Next.js runtime never
 * reads ~/.hermes/.env; that loader is for local tooling scripts).
 */
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const dsn = process.env.NEON_DATABASE_URL;
    if (!dsn) {
      throw new Error(
        "NEON_DATABASE_URL is not set — name resolution and DDI queries require the Neon DSN",
      );
    }
    pool = new pg.Pool({ connectionString: dsn, max: 3, connectionTimeoutMillis: 8000 });
    pool.on("error", (err) => {
      console.error("pg pool idle client error:", err.message);
    });
  }
  return pool;
}
