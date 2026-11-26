/**
 * scripts/backfill-mechanisms.ts — DDInter 2.0 mechanism_en backfill (P3T2 step 1).
 *
 * The DDInter 2.0 bulk CSVs carry only (id_a, name_a, id_b, name_b, level) —
 * mechanism_en is NULL on all 236,834 ddi_pairs rows (Ruling 1). The web UI
 * carries the curated mechanism text, and this script recovers it (the
 * Phase-3 UI-crawl the P1 rulings deferred):
 *
 *   1. /server/interaction-source/  (paginated DataTable, 8,466 rows)
 *        -> { id, level, interaction (mechanism text), mechanism flags }
 *   2. /server/interact/{id}/  (detail page, one GET per interaction id)
 *        -> "Basic Information  ID DDInterA and DDInterB  Interaction <text> Management …"
 *        -> the pair keys we join on + the same text (fallback if the source
 *        row's text is missing).
 *
 * Join: (DDInterID_a, DDInterID_b) -> ddi_pairs on
 *   (drug_a_ingredient, drug_b_ingredient) in EITHER direction.
 *
 * SAFETY (Ruling 1 + P3T2 contract): the upsert writes mechanism_en ONLY.
 * severity, source and all other ddi_pairs columns are never touched.
 *
 * Idempotent + resumable:
 *   - a per-id cache file data/ddinter/mechanism-cache.json is kept
 *     (checked, verified by re-running);
 *   - rows whose mechanism_en is already non-empty in the DB are skipped
 *     (progress = `WHERE mechanism_en IS NULL AND (pair in this batch)`);
 *   - the run may be killed at any time and re-run: it resumes where it
 *     stopped (cache) and skips what the DB already has.
 *
 * Politeness: ddinter2.scbdd.com is a small public research site —
 *   - at most 6 concurrent detail fetches, >=120 ms between request grants,
 *     ~30-40 min for the full 8,466 ids;
 *   - descriptive User-Agent with a contact address.
 *
 * Usage:
 *   npx tsx scripts/backfill-mechanisms.ts            # full run
 *   npx tsx scripts/backfill-mechanisms.ts --limit 100
 *   npx tsx scripts/backfill-mechanisms.ts --dry-run  # fetch+join, no DB writes
 *
 * Env: NEON_DATABASE_URL (process env, repo .env, ~/.hermes/.env).
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadHermesEnv } from "./_load-env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CACHE_FILE = join(root, "data", "ddinter", "mechanism-cache.json");

const t0 = Date.now();
const log = (m: string): void => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

// ------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const li = argv.indexOf("--limit");
const limit = li !== -1 && argv[li + 1] ? Math.max(1, Number(argv[li + 1])) : Infinity;
const dryRun = argv.includes("--dry-run");

// ------------------------------------------------------------- DSN
function resolveDsn(): string {
  const fromEnv = process.env.NEON_DATABASE_URL;
  if (fromEnv) return fromEnv;
  try {
    const envFile = readFileSync(join(root, ".env"), "utf8");
    for (const line of envFile.split("\n")) {
      const m = line.match(/^NEON_DATABASE_URL=["']?([^"'\r\n]+)["']?$/);
      if (m) return m[1];
    }
  } catch {
    /* no repo .env */
  }
  return loadHermesEnv().NEON_DATABASE_URL ?? "";
}
const dsn = resolveDsn();
if (!dsn) {
  console.error("NEON_DATABASE_URL not resolved");
  process.exit(1);
}

// ------------------------------------------------------------- HTTP
const UA = "DDICBot/0.3 (mechanism backfill, public-health screening bot; contact artefaritaKuniklo@users.noreply.github.com)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Global token clock: >=120 ms between grants -> <= ~8 req/s hard ceiling,
// with 6 workers that is well inside what DDInter's app server tolerates.
let nextGrant = 0;
async function grant(): Promise<void> {
  const now = Date.now();
  if (now < nextGrant) await sleep(nextGrant - now);
  nextGrant = Math.max(now, nextGrant) + 120;
}

async function fetchWithRetry(url: string, init: RequestInit, tries = 4): Promise<string> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    await grant();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html,application/json" },
        signal: AbortSignal.timeout(60000),
        ...init,
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} (retryable)`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === tries) throw e;
      await sleep(1200 * attempt ** 2);
    }
  }
  throw new Error("unreachable");
}

// ------------------------------------------------------------- parsing
const strip = (h: string): string =>
  h
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");

// Unique anchor per detail page (verified in probes probe10/probe11-2):
// "... Basic Information  ID DDInter975 and DDInter582  Interaction <MECH>  Management ..."
const ANCHOR = /ID\s*(DDInter\d+)\s+and\s+(DDInter\d+)\s+Interaction\s+([\s\S]*?)(?:\s+Management\s+|\s+References\b)/;

function parseDetail(html: string): { a: string; b: string; text: string } | null {
  const m = strip(html).match(ANCHOR);
  if (!m) return null;
  const text = m[3].trim();
  if (!text) return null;
  // Data quirk of the site itself: some rows begin with a stray "INTERVAL:"
  // (a truncation of "INTERVAL"/label). Keep text VERTIMATE except this
  // leading token, which is not part of the clinical statement.
  const cleaned = text.replace(/^INTERVAL:\s*/, "");
  return { a: m[1], b: m[2], text: cleaned };
}

interface SrcRow {
  id: string;
  level: string;
  text: string;
}

// ------------------------------------------------------------- step 1: interaction-source
async function fetchInteractionSource(): Promise<SrcRow[]> {
  const page = await fetchWithRetry("https://ddinter2.scbdd.com/server/interaction/", {});
  const csrf = page.match(/csrfmiddlewaretoken: '([^']+)'/)?.[1];
  if (!csrf) throw new Error("csrf token not found on /server/interaction/");
  const rows: SrcRow[] = [];
  const LEN = 1000;
  for (let start = 0; ; start += LEN) {
    const body = `csrfmiddlewaretoken=${encodeURIComponent(csrf)}&draw=1&start=${start}&length=${LEN}`;
    const text = await fetchWithRetry("https://ddinter2.scbdd.com/server/interaction-source/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://ddinter2.scbdd.com/server/interaction/",
      },
      body,
    });
    const d = JSON.parse(text) as { recordsTotal: number; data: Array<{ id: number | string; level: number | string; interaction?: string | null }> };
    log(`interaction-source start=${start} got=${d.data.length} total=${d.recordsTotal}`);
    for (const r of d.data) {
      const t = (r.interaction ?? "").trim();
      rows.push({ id: String(r.id), level: String(r.level), text: t });
    }
    if (d.data.length < LEN) break;
    await sleep(200);
  }
  return rows;
}

// ------------------------------------------------------------- cache
type CacheEntry = { a: string; b: string; text: string; v: "detail" | "source" } ;
type Cache = Record<string, CacheEntry>;
function loadCache(): Cache {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Cache;
  } catch {
    return {};
  }
}
function saveCache(cache: Cache): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  const tmp = CACHE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(cache, null, 0));
  // rename-in-place is not atomic across 9p mounts; plain overwrite is how
  // the rest of the data tooling persists caches.
  writeFileSync(CACHE_FILE, readFileSync(tmp, "utf8"));
}

// ------------------------------------------------------------- main
async function main(): Promise<void> {
  const srcRows = await fetchInteractionSource();
  let todo = srcRows.filter((r) => r.text.length > 0);
  if (Number.isFinite(limit)) todo = todo.slice(0, limit);
  log(`mechanism rows in source: ${todo.length} (of ${srcRows.length} total)`);

  const cache = loadCache();
  const fetchQueue = todo.filter((r) => !cache[r.id]);
  log(`cache hits: ${todo.length - fetchQueue.length} to-fetch: ${fetchQueue.length} (concurrency 6)`);

  let fetchFail = 0;
  const tFetch = Date.now();
  const queue = [...fetchQueue];
  const worker = async (): Promise<void> => {
    for (;;) {
      const r = queue.pop();
      if (r === undefined) break;
      try {
        const html = await fetchWithRetry(`https://ddinter2.scbdd.com/server/interact/${r.id}/`, {});
        const p = parseDetail(html);
        if (p) cache[r.id] = { a: p.a, b: p.b, text: p.text || r.text, v: p.text ? "detail" : "source" };
        else if (r.text) {
          // detail page unparseable but the source row has text: keep the text,
          // pair keys unknown -> will be skipped for the DB join, logged.
          cache[r.id] = { a: "", b: "", text: r.text, v: "source" };
        } else {
          cache[r.id] = { a: "", b: "", text: "", v: "source" };
          fetchFail++;
        }
      } catch (e) {
        fetchFail++;
        console.warn(`  fetch EXHAUSTED for ${r.id}: ${String(e).slice(0, 90)}`);
      }
      if (queue.length % 250 === 0 || queue.length === 0) {
        saveCache(cache);
        const done = fetchQueue.length - queue.length;
        const elapsed = (Date.now() - tFetch) / 1000;
        const rate = elapsed > 0 ? done / elapsed : 0;
        const eta = rate > 0 ? Math.round(queue.length / rate / 60) : 0;
        log(`  detail fetch ${done}/${fetchQueue.length} failed=${fetchFail} ${rate.toFixed(2)}/s eta=${eta}m`);
      }
    }
  };
  if (fetchQueue.length > 0) {
    await Promise.all(Array.from({ length: Math.min(6, fetchQueue.length) }, () => worker()));
    saveCache(cache);
  }

  // ------------------------------------------------------------- join + upsert
  const mkClient = (): pg.Client =>
    new pg.Client({ connectionString: dsn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  const client = mkClient();
  await client.connect();

  try {
    const pre = (await client.query("select count(*)::int n, count(mechanism_en)::int with_mech from ddi_pairs")).rows[0] as { n: number; with_mech: number };
    log(`db before: ddi_pairs=${pre.n} with-mechanism_en=${pre.with_mech}`);

    // resolve pair ids -> live ddi_pairs rows whose mechanism_en is still null
    const entries = todo
      .map((r) => ({ id: r.id, e: cache[r.id], srcText: r.text }))
      .filter((x) => x.e && x.e.a && x.e.b && (x.e.text || x.srcText));

    // batch the DB existence check per 500 pairs to keep parameters bounded
    const BATCH = 500;
    const updates: Array<{ a: string; b: string; text: string }> = [];
    let skippedHaveMech = 0;
    let notInDb = 0;
    for (let i = 0; i < entries.length; i += BATCH) {
      const chunk = entries.slice(i, i + BATCH);
      // Direction-agnostic pre-filter: every DDInter id in either slot. The
      // stored pair keeps drug_a < drug_b, but detail pages report ids in
      // source order — a slot-specific ANY() would silently drop reversed
      // entries (verified bug in the 50-row smoke run: 19 false "not-in-db").
      const allIds = [...new Set(chunk.flatMap((x) => [x.e!.a, x.e!.b]))];
      const q = await client.query(
        `select drug_a_ingredient, drug_b_ingredient, mechanism_en from ddi_pairs
         where drug_a_ingredient = any($1::text[]) and drug_b_ingredient = any($1::text[])`,
        [allIds],
      );
      const have = new Map<string, string | null>();
      for (const r of q.rows as Array<{ drug_a_ingredient: string; drug_b_ingredient: string; mechanism_en: string | null }>) {
        have.set(`${r.drug_a_ingredient}|${r.drug_b_ingredient}`, r.mechanism_en);
      }
      for (const x of chunk) {
        const { a, b, text } = { a: x.e!.a, b: x.e!.b, text: x.e!.text || x.srcText };
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const existing = have.get(key);
        if (existing === undefined) {
          notInDb++;
          continue;
        }
        if (existing !== null && existing.trim() !== "") {
          skippedHaveMech++;
          continue;
        }
        updates.push({ a: key.split("|")[0], b: key.split("|")[1], text });
      }
    }
    log(`join: to-update=${updates.length} (already-had-mech=${skippedHaveMech}, not-in-ddi_pairs=${notInDb})`);

    if (dryRun) {
      log("--dry-run: no DB writes (counts above are the projected change)");
    } else if (updates.length > 0) {
      // Per-row UPDATE (2-direction match + IS NULL guard). ~8.4k rows -> a few
      // minutes of Neon round-trips, which is the honest cost of a safe,
      // obviously-correct statement; the IS NULL guard makes a re-run a
      // genuine no-op (verified in the 50-row smoke: 2nd run touched 0 rows).
      let affected = 0;
      let i = 0;
      for (const u of updates) {
        const r = await client.query(
          "update ddi_pairs set mechanism_en = $3 " +
            "where ((drug_a_ingredient = $1 and drug_b_ingredient = $2) " +
            "   or (drug_a_ingredient = $2 and drug_b_ingredient = $1)) " +
            "  and mechanism_en is null",
          [u.a, u.b, u.text],
        );
        affected += r.rowCount ?? 0;
        i++;
        if (i % 1000 === 0 || i === updates.length) {
          log(`  db updates ${i}/${updates.length} affected=${affected}`);
        }
      }
      log(`db: ${affected} rows got mechanism_en`);
    }

    const post = (await client.query("select count(*)::int n, count(mechanism_en)::int with_mech from ddi_pairs")).rows[0] as { n: number; with_mech: number };
    const cov = (await client.query(
      `select count(distinct dp.drug_a_ingredient || '|' || dp.drug_b_ingredient)::int distinct_pairs_with_mech,
              (select count(distinct drug_a_ingredient || '|' || drug_b_ingredient)::int from ddi_pairs) total_distinct
       from ddi_pairs dp where dp.mechanism_en is not null`,
    )).rows[0] as { distinct_pairs_with_mech: number; total_distinct: number };
    log(`db after: ddi_pairs=${post.n} with-mechanism_en=${post.with_mech} (was ${pre.with_mech})`);
    log(`distinct distinct-pairs with mechanism: ${cov.distinct_pairs_with_mech}/${cov.total_distinct}`);
    if (!dryRun && post.with_mech <= pre.with_mech && updates.length > 0) {
      throw new Error(`acceptance FAILED: no rows updated (expected ${updates.length})`);
    }
  } finally {
    await client.end().catch(() => {});
  }
  log(`backfill-mechanisms: done${dryRun ? " (dry-run)" : ""}`);
}

main().catch((e) => {
  console.error("BACKFILL-MECHANISMS FAILED:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
