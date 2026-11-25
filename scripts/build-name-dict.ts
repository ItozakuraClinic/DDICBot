/**
 * scripts/build-name-dict.ts — EN+ZH drug name dictionary (task t_f6436f1d).
 *
 * Builds drug_names rows for every ingredient in the drugs table (populated
 * by scripts/import-ddinter.ts):
 *
 *   EN source — RxNorm, offline. The pre-downloaded file
 *       ./data/rxnorm_synonyms.tsv is used when present; otherwise the RxNorm
 *       full release data/rxnorm/RXNCONSO.RRF already in data/ (both files
 *       use the same 18-column Rich Release Format). Each ingredient's
 *       canonical_en is matched against the ENG names of RxNorm concepts,
 *       and the matched concepts' ENG spellings (non-suppressed, ASCII,
 *       ingredient concepts ranked first) are added as source='RxNorm'.
 *       A source='DDInter' row for canonical_en itself is always upserted,
 *       so every ingredient has >=1 lang='en' row even with zero RxNorm hits.
 *
 *   ZH source — PubChem, REST (the task-specified endpoint) or the
 *       pre-downloaded ./data/pubchem_zh_synonyms.tsv when present (two
 *       columns, EN name<TAB>zh synonym; a header or '#' line is tolerated):
 *
 *         https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/<name>/synonyms/JSON?heading=Chinese
 *
 *       PubChem is keyed by the EN compound name, not by ingredient_id, so
 *       every lookup key is canonical_en (URL-encoded; 404 is a definitive
 *       miss, 429/5xx/network retry with backoff, <=5 req/s token clock, and
 *       results are cached in data/pubchem/pubchem_zh_cache.json).
 *
 *       AUDIT NOTE (2026-11-25, measured before this run): PubChem was probed
 *       live for 20 diverse major drugs across the COMPLETE synonym lists — 0
 *       CJK (Chinese) strings in any of them — and the heading=Chinese
 *       parameter does not filter: for every test drug the response count
 *       under heading=Chinese is identical to the unfiltered list (PubChem
 *       has no "Chinese" synonym heading; the parameter is ignored
 *       server-side). The prior in-flight attempt's own scan
 *       (data/pubchem/scan-cjk.json) reached the same finding (15 compounds).
 *       Consequence, by design: this script keeps only CJK-containing
 *       synonyms in the zh column — storing "ACETYLSALICYLIC ACID" or a CAS
 *       number as lang='zh' would be silent data corruption — and ingredients
 *       with no genuine Chinese synonym receive the contract's fallback row
 *       (surface_name = canonical_en, source='fallback'). The run's measured
 *       CJK hit rate over the full drug set is logged and reported in the
 *       card handoff, where the ZH-source infeasibility is escalated.
 *
 * Per-language guarantee (contract): after the run, every ingredient_id in
 * drugs has >=1 row with lang='en' AND >=1 row with lang='zh'.
 *
 * Idempotent: all writes are
 *   INSERT ... ON CONFLICT (ingredient_id, surface_name, lang)
 *   DO UPDATE SET source = EXCLUDED.source
 * (the WHERE guard makes a no-change re-run affect 0 rows).
 *
 * Usage:
 *   npx tsx scripts/build-name-dict.ts             # full run
 *   npx tsx scripts/build-name-dict.ts --limit 25  # smoke test, first N
 *   npx tsx scripts/build-name-dict.ts --dry-run   # build + report, no DB writes
 *
 * Env:
 *   NEON_DATABASE_URL  pooled DSN (process env, then repo .env — never
 *                      hardcoded, never printed)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// -------------------------------------------------------------
// CLI
// -------------------------------------------------------------
const argv = process.argv.slice(2);
const li = argv.indexOf("--limit");
const limit = li !== -1 && argv[li + 1] ? Math.max(1, Number(argv[li + 1])) : Infinity;
const dryRun = argv.includes("--dry-run");

// -------------------------------------------------------------
// DSN (self-contained: process env, then repo .env)
// -------------------------------------------------------------
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
  throw new Error("NEON_DATABASE_URL not set (process env or repo .env)");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (label: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

// -------------------------------------------------------------
// Text helpers
// -------------------------------------------------------------
const norm = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[±]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isAscii = (s: string) => s.length > 0 && /^[\u0020-\u007E]+$/.test(s);
// Han only (unified ideographs incl. ext A + CJK compat ideographs). The
// presence of a Han character is what makes a synonym legitimately 'zh'.
const HAS_CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

// -------------------------------------------------------------
// RxNorm synonyms (offline)
// -------------------------------------------------------------
const RXN_CONSO_CANDIDATES = [
  join(root, "data", "rxnorm_synonyms.tsv"), // contract-named file
  join(root, "data", "rxnorm", "RXNCONSO.RRF"), // full release already in data/
];

interface RxConcept {
  rxcui: string;
  preferred: string;
  asciiNames: string[];
}

/**
 * Parse an 18-column RxNorm Rich Release document (pipe- or tab-delimited,
 * '#' comment lines and a literal header row tolerated). Columns of
 * interest: 1 RXCUI | 2 LAT | 13 TTY | 15 STR | 17 SUPPRESS.
 */
function loadRxNorm(): { concepts: Map<string, RxConcept>; nameIndex: Map<string, string[]> } {
  const path = RXN_CONSO_CANDIDATES.find((p) => existsSync(p));
  if (!path) {
    log("rxnorm: no local release file found; EN = canonical names only");
    return { concepts: new Map(), nameIndex: new Map() };
  }
  let raw = readFileSync(path, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const delim = raw.slice(0, 300).includes("|") ? "|" : "\t";
  const concepts = new Map<string, { preferred: string | null; names: Set<string> }>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const c = line.split(delim);
    if (c.length < 18) continue;
    const rxcui = c[0].trim();
    if (!rxcui || rxcui === "RXCUI" || c[1] !== "ENG") continue; // header / non-English
    const tty = c[12].trim();
    const str = c[14].trim();
    const suppress = c[16].trim();
    if (!str || suppress === "Y") continue; // RxNorm-editor-suppressed
    const slot = concepts.get(rxcui) ?? { preferred: null, names: new Set<string>() };
    if (tty === "IN" && slot.preferred === null) slot.preferred = str;
    slot.names.add(str);
    concepts.set(rxcui, slot);
  }
  const out = new Map<string, RxConcept>();
  const nameIndex = new Map<string, string[]>();
  for (const [rxcui, slot] of concepts) {
    const preferred = slot.preferred ?? [...slot.names].sort((a, b) => a.length - b.length)[0];
    if (!preferred) continue;
    const asciiNames = [...slot.names].filter((s) => isAscii(s));
    if (!asciiNames.length) continue;
    out.set(rxcui, { rxcui, preferred, asciiNames });
    for (const n of asciiNames) {
      const k = norm(n);
      if (!k) continue;
      const list = nameIndex.get(k) ?? [];
      if (!list.includes(rxcui)) {
        list.push(rxcui);
        nameIndex.set(k, list);
      }
    }
  }
  log(`rxnorm: ${path.split("/").pop()} | concepts=${out.size} indexed-names=${nameIndex.size}`);
  return { concepts: out, nameIndex };
}

/** Candidate RxNorm concepts for one canonical name; ingredient-like
 *  (shorter preferred name) first, max 2 (product concepts share brand
 *  spellings and inflate synonyms; the ingredient concept wins). */
function rxnormConceptsFor(
  canonical: string,
  nameIndex: Map<string, string[]>,
  concepts: Map<string, RxConcept>,
): RxConcept[] {
  const hits = nameIndex.get(norm(canonical)) ?? [];
  return hits
    .slice(0, 4)
    .sort((a, b) => (concepts.get(a)?.preferred.length ?? 99) - (concepts.get(b)?.preferred.length ?? 99))
    .slice(0, 2)
    .map((r) => concepts.get(r)!)
    .filter(Boolean);
}

// -------------------------------------------------------------
// PubChem ZH synonyms (live, rate-limited, cached)
// -------------------------------------------------------------
const PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name";
const UA = "DDICBot/0.1 (drug dictionary build; contact artefaritaKuniklo@users.noreply.github.com)";
const CACHE_FILE = join(root, "data", "pubchem", "pubchem_zh_cache.json");
const TSV_FILE = join(root, "data", "pubchem_zh_synonyms.tsv");

// Global token clock: grants >=200 ms apart -> a hard ceiling of 5 req/s.
let nextGrant = 0;
async function grant(): Promise<void> {
  const now = Date.now();
  if (now < nextGrant) await sleep(nextGrant - now);
  nextGrant = Math.max(now, nextGrant) + 200;
}

interface ZhEntry {
  /** CJK-only synonyms, deduped (may be empty). */
  zh: string[];
  status: "ok" | "miss404";
}
type ZhCache = Record<string, ZhEntry>;

function loadCache(): ZhCache {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8")) as ZhCache;
  } catch {
    return {};
  }
}
function saveCache(cache: ZhCache): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}

/**
 * Fetch a compound's synonyms via the contract endpoint and keep only the
 * CJK ones (see the audit note in the header): PubChem's synonym lists carry
 * no Chinese in the tested set, and unfiltered output (English brand names,
 * CAS numbers, etc.) must never be stored as lang='zh'.
 */
async function pubchemZh(canonical: string): Promise<ZhEntry> {
  const url = `${PUBCHEM_BASE}/${encodeURIComponent(canonical)}/synonyms/JSON?heading=Chinese`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await grant();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 404) return { zh: [], status: "miss404" };
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} (retryable)`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = (await res.json()) as {
        InformationList?: { Information?: Array<{ Synonym?: unknown[] }> };
      };
      const all: string[] = [];
      for (const rec of doc.InformationList?.Information ?? []) {
        for (const s of rec.Synonym ?? []) {
          if (typeof s === "string") all.push(s);
          else if (s && typeof s === "object") {
            // full-list shape: entries are {String, SourceName, SourceID}
            const v = (s as { String?: unknown }).String;
            if (typeof v === "string") all.push(v);
          }
        }
      }
      const seen = new Set<string>();
      const zh: string[] = [];
      for (const s of all) {
        const v = s.trim();
        if (!v || !HAS_CJK.test(v)) continue;
        const k = v.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        zh.push(v);
      }
      return { zh, status: "ok" };
    } catch (e) {
      if (attempt === 4) throw e; // exhausted: NOT cached -> retried next run
      await sleep(1500 * attempt ** 2);
    }
  }
  throw new Error("unreachable");
}

/** Pre-downloaded TSV, if present: EN name<TAB>zh synonym. */
function loadPubchemTsv(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!existsSync(TSV_FILE)) return out;
  let raw = readFileSync(TSV_FILE, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const key = norm(parts[0]);
    const val = parts[1].trim();
    if (!key || !val) continue;
    const list = out.get(key) ?? [];
    list.push(val);
    out.set(key, list);
  }
  log(`pubchem: pre-downloaded ${TSV_FILE} | names=${out.size}`);
  return out;
}

// -------------------------------------------------------------
// Row model
// -------------------------------------------------------------
interface DrugRef {
  ingredient_id: string;
  canonical: string; // canonical_en; ingredient_id as last-resort surface
}
interface NameRow {
  ingredient_id: string;
  surface_name: string;
  lang: "en" | "zh";
  source: string;
}

function buildEnRows(
  drugs: DrugRef[],
  rx: { concepts: Map<string, RxConcept>; nameIndex: Map<string, string[]> },
): { rows: NameRow[]; rxnormHits: number } {
  const rows: NameRow[] = [];
  let rxnormHits = 0;
  for (const d of drugs) {
    rows.push({ ingredient_id: d.ingredient_id, surface_name: d.canonical, lang: "en", source: "DDInter" });
    const cands = rxnormConceptsFor(d.canonical, rx.nameIndex, rx.concepts);
    if (!cands.length) continue;
    rxnormHits++;
    const canonNorm = norm(d.canonical);
    for (const c of cands) {
      for (const s of c.asciiNames) {
        if (s.length >= 2 && norm(s) !== canonNorm) {
          rows.push({ ingredient_id: d.ingredient_id, surface_name: s, lang: "en", source: "RxNorm" });
        }
      }
    }
  }
  return { rows, rxnormHits };
}

// -------------------------------------------------------------
// Main
// -------------------------------------------------------------
async function main(): Promise<void> {
  const dsn = resolveDsn();
  const mkClient = (): pg.Client => {
    const c = new pg.Client({
      connectionString: dsn,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 20000,
    });
    // The ZH network phase leaves the pooled connection idle for minutes;
    // PgBouncer drops idle sockets (and transient TLS handshake failures
    // happen on WSL). Swallow the event — every code path reaches back
    // through freshClient(), which liveness-checks and rebuilds the client
    // before the write phase.
    c.on("error", () => {
      /* expected on idle drop; freshClient() rebuilds before the write phase */
    });
    return c;
  };
  // Mutable binding: a failed connect leaves a pg.Client half-connected, and
  // node-postgres refuses any later `.connect()`/reuse of that object — the
  // only safe recovery is to build a FRESH client instance.
  let client = mkClient();
  const discardClient = async (): Promise<void> => {
    const old = client;
    client = mkClient();
    try {
      await old.end();
    } catch {
      /* already gone */
    }
  };
  const connectWithRetry = async (label: string): Promise<void> => {
    for (let i = 0; ; i++) {
      try {
        await client.connect();
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const retriable = /socket|connection|terminated|ECONN|ETIMEDOUT|TLS|reuse/i.test(msg);
        if (!retriable || i >= 4) throw e;
        log(`${label} db connect failed (${msg}); retry ${i + 1}/4 with a fresh client`);
        await discardClient();
        await sleep(2000 * (i + 1));
      }
    }
  };
  await connectWithRetry("initial");
  const freshClient = async (): Promise<void> => {
    try {
      await client.query("select 1");
    } catch {
      await discardClient();
      await connectWithRetry("re");
    }
  };

  try {
    // ---- 1. inventory: read the drugs table (contract step 1)
    const res = await client.query(`select ingredient_id, canonical_en from drugs order by ingredient_id`);
    const rawRows = res.rows as unknown as Array<{ ingredient_id: string; canonical_en: string | null }>;
    const all: DrugRef[] = rawRows.map((r) => ({
      ingredient_id: String(r.ingredient_id),
      canonical: r.canonical_en && r.canonical_en.trim() ? (r.canonical_en as string).trim() : String(r.ingredient_id),
    }));
    const noCanon = rawRows.filter((r) => !r.canonical_en || !r.canonical_en.trim()).length;
    if (noCanon) log(`drugs with null/empty canonical_en: ${noCanon} (ingredient_id used as surface name)`);
    const drugs = Number.isFinite(limit) ? all.slice(0, limit) : all;
    const testIds = drugs.map((d) => d.ingredient_id);
    log(`ingredients from drugs table: ${drugs.length} (of ${all.length})${Number.isFinite(limit) ? ` [--limit ${limit}]` : ""}${dryRun ? " [--dry-run]" : ""}`);

    // ---- 2. EN rows (offline RxNorm)
    const rx = loadRxNorm();
    const { rows: enRows, rxnormHits } = buildEnRows(drugs, rx);
    log(`EN rows prepared: ${enRows.length} (rxnorm concept hits: ${rxnormHits}/${drugs.length})`);

    // ---- 3. ZH rows (PubChem: cache -> live API; TSV used when present)
    const tsv = loadPubchemTsv();
    const cache = loadCache();
    const zhRows: NameRow[] = [];
    const zhSurfaces = new Map<string, Set<string>>(); // ingredient_id -> Set<lower zh surface>
    const addZh = (d: DrugRef, name: string, source: string): void => {
      zhRows.push({ ingredient_id: d.ingredient_id, surface_name: name, lang: "zh", source });
      const set = zhSurfaces.get(d.ingredient_id) ?? new Set<string>();
      set.add(name.toLowerCase());
      zhSurfaces.set(d.ingredient_id, set);
    };

    // Group drugs by canonical key: PubChem keys are EN compound names, and
    // more than one ingredient_id may share a name — every drug in a group
    // must receive the same ZH resolution.
    const byKey = new Map<string, DrugRef[]>();
    for (const d of drugs) {
      const k = norm(d.canonical);
      const arr = byKey.get(k) ?? [];
      arr.push(d);
      byKey.set(k, arr);
    }

    // Fetch keys not already cached and not served by the TSV (5 req/s).
    const needFetch = [...byKey.keys()].filter((k) => !cache[k] && !tsv.has(k));
    log(`ZH keys: total=${byKey.size} pre-downloaded-tsv=${tsv.size} cached=${Object.keys(cache).filter((k) => byKey.has(k)).length} to-fetch=${needFetch.length} (@<=5 req/s)`);

    const stats = {
      apiCalls: 0,
      miss404: 0,
      failed: 0,
      keysCjk: 0, // keys that yield >=1 CJK zh name (final)
      keysEmpty: 0, // keys with no usable zh name (final)
    };
    const queue = [...needFetch];
    let done = 0;
    const total = queue.length;
    const tFetch = Date.now();
    const worker = async (): Promise<void> => {
      for (;;) {
        const k = queue.pop();
        if (k === undefined) break;
        const term = byKey.get(k)![0].canonical; // EN query term for this key
        try {
          const entry = await pubchemZh(term);
          cache[k] = entry;
          stats.apiCalls++;
          if (entry.status === "miss404") stats.miss404++;
        } catch (e) {
          stats.failed++;
          console.warn(`  zh fetch EXHAUSTED for "${term}": ${String(e).slice(0, 90)}`);
        }
        done++;
        if (done % 50 === 0 || done === total) {
          saveCache(cache);
          const elapsed = (Date.now() - tFetch) / 1000;
          const rps = elapsed > 0 ? done / elapsed : 0;
          const etaMin = rps > 0 ? Math.round((total - done) / rps / 60) : 0;
          log(`  zh fetch ${done}/${total} | 404=${stats.miss404} failed=${stats.failed} | ${rps.toFixed(2)} req/s | eta ${etaMin}m`);
        }
      }
    };
    if (total > 0) await Promise.all(Array.from({ length: Math.min(5, total) }, () => worker()));
    if (total > 0) saveCache(cache);

    // Materialize ZH rows for EVERY drug: TSV takes precedence, else cache
    // (which now includes both this run's fetches and any prior cache).
    for (const [k, group] of byKey) {
      let zhNames: string[] = [];
      if (tsv.has(k)) {
        const seen = new Set<string>();
        for (const s of tsv.get(k)!) {
          const v = s.trim();
          if (!v || !HAS_CJK.test(v)) continue;
          const lk = v.toLowerCase();
          if (seen.has(lk)) continue;
          seen.add(lk);
          zhNames.push(v);
        }
      } else {
        const entry = cache[k];
        zhNames = entry ? [...entry.zh] : [];
      }
      if (zhNames.length === 0) stats.keysEmpty++;
      else stats.keysCjk++;
      for (const d of group) for (const s of zhNames) addZh(d, s, "PubChem");
    }

    // ---- 4. per-language fallback guarantee (contract step 3)
    const enByIngredient = new Map<string, NameRow[]>();
    for (const r of enRows) {
      const list = enByIngredient.get(r.ingredient_id) ?? [];
      list.push(r);
      enByIngredient.set(r.ingredient_id, list);
    }
    const zhByIngredient = new Map<string, NameRow[]>();
    for (const r of zhRows) {
      const list = zhByIngredient.get(r.ingredient_id) ?? [];
      list.push(r);
      zhByIngredient.set(r.ingredient_id, list);
    }
    const finalRows: NameRow[] = [];
    const seen = new Set<string>();
    const push = (r: NameRow): void => {
      const k = `${r.ingredient_id}\u0000${r.surface_name.toLowerCase()}\u0000${r.lang}`;
      if (seen.has(k)) return;
      seen.add(k);
      finalRows.push(r);
    };
    let zhFallback = 0;
    let enFallback = 0;
    for (const d of drugs) {
      for (const r of enByIngredient.get(d.ingredient_id) ?? []) push(r);
      for (const r of zhByIngredient.get(d.ingredient_id) ?? []) push(r);
      const hasZh = (zhSurfaces.get(d.ingredient_id)?.size ?? 0) > 0;
      if (!hasZh) {
        push({ ingredient_id: d.ingredient_id, surface_name: d.canonical, lang: "zh", source: "fallback" });
        zhFallback++;
      }
      if ((enByIngredient.get(d.ingredient_id)?.length ?? 0) === 0) {
        push({ ingredient_id: d.ingredient_id, surface_name: d.canonical, lang: "en", source: "fallback" });
        enFallback++;
      }
    }
    log(
      `ZH outcome: keys-with-cjk=${stats.keysCjk} keys-empty=${stats.keysEmpty} of ${byKey.size} keys | api-fetched=${stats.apiCalls} 404=${stats.miss404} fetch-failed=${stats.failed}`,
    );
    log(`rows to upsert: ${finalRows.length} (en=${finalRows.filter((r) => r.lang === "en").length} zh=${finalRows.filter((r) => r.lang === "zh").length}) | zh-fallback=${zhFallback} en-fallback=${enFallback}`);

    // ---- 5. upsert (ON CONFLICT ... DO UPDATE SET source = EXCLUDED.source)
    if (dryRun) {
      log("--dry-run: no DB writes performed (counts above are the projected change)");
    } else {
      await freshClient();
      // Preflight: ON CONFLICT needs a unique constraint/index on the triple.
      // (Present on this branch as drug_names_ingredient_id_surface_name_lang_key;
      // the check exists so a fresh environment fails with actionable text.)
      const hasTripleUq =
        ((await client.query(
          `select pg_get_constraintdef(oid) as def
           from pg_constraint
           where conrelid = 'drug_names'::regclass and contype = 'u'`,
        )).rows as Array<{ def: string }>).some((r) =>
          /ingredient_id[^,]*\s*,\s*surface_name[^,]*\s*,\s*lang/.test(r.def),
        ) ||
        ((await client.query(
          `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'drug_names'`,
        )).rows as Array<{ indexdef: string }>).some((r) =>
          /UNIQUE\s*\(\s*ingredient_id\s*,\s*surface_name\s*,\s*lang\s*\)/i.test(r.indexdef) &&
          !/pkey/i.test(r.indexdef),
        );
      if (!hasTripleUq) {
        throw new Error(
          "drug_names lacks UNIQUE (ingredient_id, surface_name, lang); ON CONFLICT would fail. " +
            "Run: create unique index uq_drug_names_ingredient_surface_lang on drug_names (ingredient_id, surface_name, lang);",
        );
      }
      const BATCH = 500;
      let affected = 0;
      for (let i = 0; i < finalRows.length; i += BATCH) {
        const batch = finalRows.slice(i, i + BATCH);
        const vals = batch.map((_, j) => `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`);
        const params: unknown[] = [];
        for (const r of batch) params.push(r.ingredient_id, r.surface_name, r.lang, r.source);
        const q = await client.query(
          `insert into drug_names (ingredient_id, surface_name, lang, source)
           values ${vals.join(",")}
           on conflict (ingredient_id, surface_name, lang)
           do update set source = excluded.source
           where drug_names.source is distinct from excluded.source`,
          params,
        );
        affected += q.rowCount ?? 0;
        log(`  upsert batch ${Math.min(i + BATCH, finalRows.length)}/${finalRows.length} | affected-so-far=${affected}`);
      }
      log(`db writes complete: ${affected} rows inserted-or-updated`);
    }

    // ---- 6. acceptance verification (exact contract queries)
    // Scoped to the tested ingredient_ids so --limit smoke tests gate on
    // themselves; for a full run testIds is the whole table.
    const acc = (
      await client.query(
        `select
           (select count(*)::int from drug_names where lang='zh') as zh_total,
           (select count(*)::int from drugs d
              left join drug_names n on d.ingredient_id=n.ingredient_id and n.lang='zh'
              where d.ingredient_id = any($1::text[]) and n.id is null) as zh_missing,
           (select count(*)::int from drugs d
              left join drug_names n on d.ingredient_id=n.ingredient_id and n.lang='en'
              where d.ingredient_id = any($1::text[]) and n.id is null) as en_missing`,
        [testIds],
      )
    ).rows[0] as { zh_total: number; zh_missing: number; en_missing: number };
    const byLang = (await client.query(`select lang, count(*)::int n from drug_names group by lang order by lang`)).rows;
    log(`db drug_names by lang: ${JSON.stringify(byLang)}`);
    log(`acceptance (scoped to ${testIds.length}): zh_total=${acc.zh_total} (required >0) zh_missing=${acc.zh_missing} en_missing=${acc.en_missing} (required 0)`);

    if (dryRun) {
      const projEn = new Set(enByIngredient.keys()).size;
      const projZh = new Set(zhByIngredient.keys()).size;
      log(`projected per-ingredient coverage: en=${projEn}/${drugs.length} zh=${projZh}/${drugs.length} (dry-run: zh_missing/en_missing above reflect the CURRENT db, not the projection)`);
    } else if (acc.zh_total === 0 || acc.zh_missing > 0 || acc.en_missing > 0) {
      throw new Error(`acceptance FAILED: ${JSON.stringify(acc)}`);
    } else {
      log(`acceptance PASSED${Number.isFinite(limit) ? " for the scoped set" : ""}`);
    }
    log(`build-name-dict: done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("BUILD-NAME-DICT FAILED:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
