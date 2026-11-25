// Drop the superseded branch-DB table shapes (previous in-flight attempt) so
// the canonical db/schema.sql can create them cleanly. The branch is a
// dev/experiment branch; these tables were empty (0 rows at probe time).
import pg from "pg";
import { loadHermesEnv } from "../scripts/_load-env.ts";

const c = new pg.Client({ connectionString: loadHermesEnv().NEON_DATABASE_URL });
c
  .connect()
  .then(async () => {
    for (const t of ["drug_names", "ddi_pairs", "drugs"]) {
      const r = await c.query(`select count(*)::int as n from ${t}`);
      const n = (r.rows[0] as { n: number }).n;
      if (n > 0) {
        console.error(`REFUSING to drop ${t}: it has ${n} rows`);
        process.exitCode = 1;
        continue;
      }
      await c.query(`drop table if exists ${t} cascade`);
      console.log(`dropped empty table ${t}`);
    }
    await c.end();
  })
  .catch((e: Error) => {
    console.error("FAIL:", e.message);
    process.exit(1);
  });
