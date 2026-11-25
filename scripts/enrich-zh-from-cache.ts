/**
 * scripts/enrich-zh-from-cache.ts — backfill real Chinese labels into drug_names
 * (task t_645afc71, follow-up to t_f6436f1d).
 *
 * Background: PubChem carries zero CJK synonyms (proven in t_f6436f1d), so the
 * build-name-dict run left every zh row as source='fallback' (surface_name =
 * canonical_en). A local Wikidata cache, ./data/name-dict/zh-cache.json — a
 * flat JSON object mapping DDInter ingredient_id -> real CJK label — holds
 * genuine Chinese names. This script copies the CJK-containing entries into
 * drug_names as NEW rows (lang='zh', source='wikidata') and does not touch the
 * fallback rows: the cache label differs from the canonical_en fallback string,
 * so the rows coexist under UNIQUE(ingredient_id, surface_name, lang). Drugs
 * the cache misses keep their fallback row as coverage (100% zh coverage
 * invariance is verified with --verify).
 *
 * Semantics per cache entry:
 *   - value must be a non-empty string containing at least one Han ideograph
 *     (CJK Unified Ideographs, [\u4e00-\u9fff] — the guard the planner
 *     pre-verified against the cache to expect 1,261 keepers / 4 junk);
 *   - key must exist in drugs.ingredient_id (pre-loaded into a Set).
 *
 * The upsert is:
 *   INSERT INTO drug_names (ingredient_id, surface_name, lang, source)
 *   VALUES (...), ...
 *   ON CONFLICT (ingredient_id, surface_name, lang) DO UPDATE
 *     SET source = EXCLUDED.source
 *     WHERE drug_names.source <> EXCLUDED.source
 * The WHERE guard makes a no-change re-run genuinely 0 rows affected
 * (rowCount), not "1,261 updated to the same value".
 *
 * Usage:
 *   npx tsx scripts/enrich-zh-from-cache.ts            # upsert run
 *   npx tsx scripts/enrich-zh-from-cache.ts --dry-run  # validate + report, no writes
 *   npx tsx scripts/enrich-zh-from-cache.ts --verify   # acceptance checks only
 *
 * Hard stop: if the cache file is missing or malformed, the script reports the
 * exact finding and exits 1. This lane never fetches Wikidata live.
 *
 * Env:
 *   NEON_DATABASE_URL  pooled DSN (process env, then ~/.hermes/.env via
 *                      scripts/_load-env.ts — never hardcoded, never printed)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadHermesEnv } from "./_load-env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CACHE_PATH = join(root, "data", "name-dict", "zh-cache.json");
const BATCH = 500;

// Same guard the cache was pre-verified against (expect 1,261 / 4 junk).
const HAS_CJK = /[\u4e00-\u9fff]/;

const t0 = Date.now();
const log = (label: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

async function main() {
  const dsn = loadHermesEnv().NEON_DATABASE_URL;
  if (!dsn) {
    console.error("FAIL: NEON_DATABASE_URL not resolved (process env or ~/.hermes/.env)");
    process.exit(1);
  }
  const c = new pg.Client({ connectionString: dsn });
  await c.connect();

  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const verifyOnly = argv.includes("--verify");

  // ------------------------------------------------------------
  // Cache: read + validate (hard stop on missing/malformed)
  // ------------------------------------------------------------
  let raw: string;
  if (!existsSync(CACHE_PATH)) {
    console.error(`STOP: cache file missing: ${CACHE_PATH}`);
    process.exit(1);
  }
  try {
    raw = readFileSync(CACHE_PATH, "utf8");
  } catch (e) {
    console.error(`STOP: cache file unreadable: ${(e as Error).message}`);
    process.exit(1);
  }
  let cache: Record<string, unknown>;
  try {
    cache = JSON.parse(raw);
    if (cache === null || typeof cache !== "object" || Array.isArray(cache)) {
      throw new Error("top-level JSON value is not an object");
    }
  } catch (e) {
    console.error(`STOP: cache file malformed (${CACHE_PATH}): ${(e as Error).message.slice(0, 200)}`);
    process.exit(1);
  }
  const entries = Object.entries(cache);
  log(`cache: ${entries.length} entries read from data/name-dict/zh-cache.json`);

  // ------------------------------------------------------------
  // Validate each entry against the live drugs table
  // ------------------------------------------------------------
  const d = await c.query("SELECT ingredient_id FROM drugs");
  const liveIds = new Set<string>(d.rows.map((r: { ingredient_id: string }) => r.ingredient_id));
  log(`drugs: ${liveIds.size} live ingredient_ids`);

  const upserts: Array<{ id: string; name: string; known: boolean }> = [];
  let skippedNonCJK = 0;
  let skippedUnknown = 0;
  const nonCJKKeys: string[] = [];
  const unknownKeys: string[] = [];
  for (const [id, value] of entries) {
    const okText =
      typeof value === "string" && value.length > 0 && HAS_CJK.test(value);
    if (!okText) {
      skippedNonCJK += 1;
      nonCJKKeys.push(`${id}=${typeof value === "string" ? value : JSON.stringify(value)}`);
      continue;
    }
    if (!liveIds.has(id)) {
      skippedUnknown += 1;
      unknownKeys.push(id);
      continue;
    }
    upserts.push({ id, name: value, known: true });
  }
  log(
    `validation: keep=${upserts.length} skipped-non-CJK=${skippedNonCJK} skipped-unknown-id=${skippedUnknown}`,
  );
  if (nonCJKKeys.length) log(`  non-CJK junk: ${nonCJKKeys.join(" | ")}`);
  if (unknownKeys.length) log(`  unknown ids: ${unknownKeys.join(", ")}`);

  // ------------------------------------------------------------
  // --verify: acceptance checks only, no writes
  // ------------------------------------------------------------
  if (verifyOnly) {
    const a = await c.query(
      "SELECT count(*)::int n FROM drug_names WHERE lang='zh' AND source='wikidata'",
    );
    log(`(a) zh+wikidata rows: ${a.rows[0].n} (cache keepers above: ${upserts.length})`);
    const b = await c.query(
      `SELECT count(*)::int n FROM drugs d WHERE NOT EXISTS (
         SELECT 1 FROM drug_names dn
         WHERE dn.ingredient_id = d.ingredient_id AND dn.lang = 'zh')`,
    );
    log(`(b) drugs without any zh row: ${b.rows[0].n}`);
    const fb = await c.query(
      "SELECT count(*)::int n FROM drug_names WHERE lang='zh' AND source='fallback'",
    );
    log(`    zh fallback rows preserved: ${fb.rows[0].n}`);
    const cc = await c.query("SELECT count(*)::int n FROM ddi_pairs");
    log(`(c) ddi_pairs rows: ${cc.rows[0].n}`);
    const spot = await c.query(
      `SELECT ingredient_id, surface_name, source
       FROM drug_names
       WHERE lang = 'zh' AND (ingredient_id, surface_name) IN
             (('DDInter20','阿司匹林'), ('DDInter1675','辛伐他汀'), ('DDInter743','氟康唑'))`,
    );
    log(
      `(d) spot-check (want 3 rows, source=wikidata): ${JSON.stringify(spot.rows)}`,
    );
    const total = await c.query(
      "SELECT lang, count(*)::int n FROM drug_names GROUP BY 1 ORDER BY 1",
    );
    log(`    drug_names by lang: ${JSON.stringify(total.rows)}`);
    const pass =
      a.rows[0].n === upserts.length &&
      b.rows[0].n === 0 &&
      cc.rows[0].n === 236834 &&
      spot.rows.length === 3 &&
      spot.rows.every((r: { source: string }) => r.source === "wikidata");
    console.log(pass ? "VERIFY PASS" : "VERIFY FAIL");
    await c.end();
    process.exit(pass ? 0 : 1);
  }

  if (dryRun) {
    log("--dry-run: no DB writes performed");
    await c.end();
    process.exit(0);
  }

  // ------------------------------------------------------------
  // Pre-classify (for the summary): which keys already exist in zh
  // rows -> would-update; rest -> would-insert.
  // ------------------------------------------------------------
  const ex = await c.query(
    "SELECT ingredient_id, surface_name, source FROM drug_names WHERE lang = 'zh'",
  );
  const existing = new Map<string, string>(
    ex.rows.map(
      (r: { ingredient_id: string; surface_name: string; source: string }) =>
        [`${r.ingredient_id}\u0000${r.surface_name}`, r.source],
    ),
  );
  let expectedInsert = 0;
  let expectedUpdate = 0;
  for (const u of upserts) {
    const prev = existing.get(`${u.id}\u0000${u.name}`);
    if (prev === undefined) expectedInsert++;
    else if (prev !== "wikidata") expectedUpdate++;
    // else: already source='wikidata' — WHERE guard skips it, no effect
  }

  // ------------------------------------------------------------
  // Batched upsert (multi-row VALUES, one statement per batch)
  // ------------------------------------------------------------
  let affected = 0;
  const nBatch = Math.ceil(upserts.length / BATCH);
  for (let i = 0; i < upserts.length; i += BATCH) {
    const batch = upserts.slice(i, i + BATCH);
    const params: string[] = [];
    const values = batch
      .map((u, j) => {
        params.push(u.id, u.name);
        return `($${j * 2 + 1}, $${j * 2 + 2}, 'zh', 'wikidata')`;
      })
      .join(", ");
    const sql = `INSERT INTO drug_names (ingredient_id, surface_name, lang, source)
      VALUES ${values}
      ON CONFLICT (ingredient_id, surface_name, lang) DO UPDATE
        SET source = EXCLUDED.source
      WHERE drug_names.source <> EXCLUDED.source`;
    const r = await c.query(sql, params);
    affected += r.rowCount ?? 0;
    log(
      `batch ${i / BATCH + 1}/${nBatch}: rowCount=${String(r.rowCount ?? 0).padStart(5)} ` +
        `(running total ${affected})`,
    );
  }

  // ------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------
  console.log("--- summary ---");
  console.log(
    `cache entries:      ${entries.length}`,
  );
  console.log(`skipped-non-CJK:    ${skippedNonCJK}`);
  console.log(`skipped-unknown-id: ${skippedUnknown}`);
  console.log(`expected insert:    ${expectedInsert}`);
  console.log(`expected update:    ${expectedUpdate}`);
  console.log(`rows affected:      ${affected}`);
  if (affected === expectedInsert + expectedUpdate) {
    console.log("OK: affected rows match expectations (inserts + source flips)");
  } else {
    console.log("NOTE: affected rows differ from pre-classification — inspect before re-running");
  }
  await c.end();
}

main().catch((e: Error) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
