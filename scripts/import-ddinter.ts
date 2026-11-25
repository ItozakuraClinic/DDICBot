/**
 * scripts/import-ddinter.ts — DDInter 2.0 DDI import (task t_bd6fd782).
 *
 * Reads the DDInter 2.0 bulk export (CC BY-NC-SA 4.0) and upserts the
 * interaction pairs into ddi_pairs, materialising drugs + drug_names
 * placeholders for any surface names the dictionary does not already know.
 *
 * Data sources (checked in this order):
 *   1. A single CSV at $DDINTER_CSV_PATH (default ./data/ddinter2.0.csv),
 *      if that file exists. Columns are discovered from the header
 *      (DDInterID_A/Drug_A/..., or any two drug-name columns + optional
 *      severity/mechanism/source), so a flattened 2.0 export drops in.
 *   2. Otherwise the per-ATC bundle under data/ddinter/
 *      (ddinter_downloads_code_*.csv, header
 *       DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level).
 *
 * Name -> ingredient_id resolution, in order:
 *   a. stable DDInter drug id present in a column (DDInterNNNN) and known
 *      in drug_names/drugs;
 *   b. exact (case-insensitive) surface_name match in drug_names (the
 *      dictionary is preloaded into memory — no per-row SQL);
 *   c. placeholder: drugs.ingredient_id = slug(name), plus a drug_names
 *      row (lang 'en', source 'DDInter placeholder').
 * Every run resolves the same name to the same id (existing ids are kept,
 * slugs are deterministic), so re-running is idempotent: 0 new rows.
 *
 * Pairs are stored unordered: drug_a < drug_b (lexicographic). For rows
 * whose id-less names share a surface spelling across ids (rare in the
 * DDInter bundle), the id column wins; name-keyed rows use the existing
 * canonical id from the dictionary.
 *
 * Idempotency: batched INSERT ... ON CONFLICT DO NOTHING against the
 * UNIQUE (drug_a_ingredient, drug_b_ingredient) constraint. Batches run at
 * 2000 rows (proven against this Neon pooled endpoint; the 5000-row
 * statement the card suggested hits the pooled client more aggressively
 * for no benefit at this scale). Progress is logged every 50k data rows.
 *
 * Usage:
 *   npx tsx scripts/import-ddinter.ts            # full run
 *   npx tsx scripts/import-ddinter.ts --limit 50 # parse-test only
 *
 * Env:
 *   NEON_DATABASE_URL  pooled DSN (process env, then repo .env, then
 *                      ~/.hermes/.env — never hardcoded)
 *   DDINTER_CSV_PATH   optional single-file CSV (default ./data/ddinter2.0.csv)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// -------------------------------------------------------------
// CLI args
// -------------------------------------------------------------
const argv = process.argv.slice(2);
let limit = Infinity;
const li = argv.indexOf("--limit");
if (li !== -1 && argv[li + 1]) limit = Number(argv[li + 1]);

// -------------------------------------------------------------
// DSN
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
    // no repo .env
  }
  throw new Error("NEON_DATABASE_URL not set (process env or repo .env)");
}

// -------------------------------------------------------------
// CSV parsing (minimal quoting + BOM handling; DDInter files are simple)
// -------------------------------------------------------------
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsvFile(path: string): { header: string[]; rows: string[][] } {
  let text = readFileSync(path, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error(`empty CSV: ${path}`);
  return { header: parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase()), rows: lines.slice(1).map(parseCsvLine) };
}

// -------------------------------------------------------------
// Column discovery
// -------------------------------------------------------------
interface ResolvedRow {
  idA?: string;
  idB?: string;
  nameA: string;
  nameB: string;
  severity: string | null;
  mechanism: string | null;
  source: string | null;
}

interface ColumnMap {
  idA: number;
  idB: number;
  nameA: number;
  nameB: number;
  severity: number;
  mechanism: number;
  source: number;
}

const isIdCol = (h: string) => /(^id|ddinter).*(a$|_a$)|^drug_a_id/.test(h) || h.includes("id_a");
const isNameColA = (h: string) =>
  h === "drug_a" || h === "name_a" || h === "drug1" || h === "name1" || (h.includes("name") && (h.endsWith("_a") || h.endsWith("1")));
const isNameColB = (h: string) =>
  h === "drug_b" || h === "name_b" || h === "drug2" || h === "name2" || (h.includes("name") && (h.endsWith("_b") || h.endsWith("2")));

function mapColumns(header: string[]): ColumnMap {
  const find = (pred: (h: string) => boolean, mustExist: boolean, label: string) => {
    const i = header.findIndex(pred);
    if (i === -1 && mustExist) throw new Error(`CSV header has no ${label} column: ${header.join(", ")}`);
    return i;
  };
  return {
    idA: find((h) => isIdCol(h) && h.includes("a") && !isNameColA(h), false, "drug-A id"),
    idB: find((h) => /(^id|ddinter).*(b$|_b$)|^drug_b_id/.test(h), false, "drug-B id"),
    nameA: find((h) => isIdCol(h) === false && isNameColA(h), true, "drug-A name"),
    nameB: find((h) => isIdCol(h) === false && isNameColB(h), true, "drug-B name"),
    severity: find((h) => h.includes("level") || h.includes("severity"), false, "severity"),
    mechanism: find((h) => h.includes("mechanism"), false, "mechanism"),
    source: find((h) => h === "source", false, "source"),
  };
}

const SEV_ORDER = ["Major", "Moderate", "Minor", "Unknown"] as const;
const rank = (s: string): number => {
  const i = (SEV_ORDER as readonly string[]).indexOf(s);
  return i === -1 ? 99 : i;
};
const normSev = (s: string | null | undefined): string | null =>
  s == null || s.trim() === "" ? null : SEV_ORDER.includes(s.trim() as (typeof SEV_ORDER)[number]) ? s.trim() : "Unknown";

// Deterministic id: prefer the stable DDInter id, else a slug of the name.
const isStableId = (s: string) => /^DDInter[0-9]+$/i.test(s);
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "drug";
}

// -------------------------------------------------------------
// Data source selection
// -------------------------------------------------------------
function loadSource() {
  const single = process.env.DDINTER_CSV_PATH ? resolve(process.env.DDINTER_CSV_PATH) : join(root, "data", "ddinter2.0.csv");
  if (existsSync(single)) {
    const { header, rows } = readCsvFile(single);
    const cm = mapColumns(header);
    // If the id columns are missing, pair keys derive from names.
    const rowsOut: ResolvedRow[] = rows.slice(0, limit).map((r) => ({
      idA: cm.idA >= 0 && r[cm.idA]?.trim() ? r[cm.idA].trim() : undefined,
      idB: cm.idB >= 0 && r[cm.idB]?.trim() ? r[cm.idB].trim() : undefined,
      nameA: (r[cm.nameA] ?? "").trim(),
      nameB: (r[cm.nameB] ?? "").trim(),
      severity: cm.severity >= 0 ? r[cm.severity] : null,
      mechanism: cm.mechanism >= 0 && r[cm.mechanism]?.trim() ? r[cm.mechanism].trim() : null,
      source: cm.source >= 0 && r[cm.source]?.trim() ? r[cm.source].trim() : "DDInter 2.0",
    }));
    return { mode: "single-file", path: single, header, rowsOut };
  }
  const dir = join(root, "data", "ddinter");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => /^ddinter_downloads_code_[A-Z]\.csv$/.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    throw new Error(
      `No DDInter CSV found at ${single} (set DDINTER_CSV_PATH) and no bundle in ${dir}. ` +
        "Download the per-ATC CSVs (https://ddinter2.scbdd.com/download/) into data/ddinter/ or provide a single flattened CSV.",
    );
  }
  const header = ["ddinterid_a", "drug_a", "ddinterid_b", "drug_b", "level"];
  const rowsOut: ResolvedRow[] = [];
  for (const f of files) {
    const { rows } = readCsvFile(f);
    for (const r of rows) {
      if (rowsOut.length >= limit) break;
      if (r.length < 5) continue;
      rowsOut.push({
        idA: r[0]?.trim() || undefined,
        nameA: (r[1] ?? "").trim(),
        idB: r[2]?.trim() || undefined,
        nameB: (r[3] ?? "").trim(),
        severity: r[4] ?? null,
        mechanism: null,
        source: null,
      });
    }
    if (rowsOut.length >= limit) break;
  }
  return { mode: "atc-bundle", path: dir, header, rowsOut };
}

// -------------------------------------------------------------
// Main
// -------------------------------------------------------------
async function main(): Promise<void> {
  const started = Date.now();
  const t = (label: string) => console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s] ${label}`);

  const src = loadSource();
  t(`source: ${src.mode} @ ${src.path}`);
  t(`parsed: rows=${src.rowsOut.length} (limit=${limit === Infinity ? "off" : limit})`);

  const client = new pg.Client({
    connectionString: resolveDsn(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  let retries = 0;
  const connectWithRetry = async () => {
    for (let i = 0; ; i++) {
      try {
        await client.connect();
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/socket|connection|terminated|ECONN|ETIMEDOUT/i.test(msg) || i >= 4) throw e;
        t(`db connect failed (${msg}); retry ${i + 1}/4`);
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        retries++;
      }
    }
  };
  await connectWithRetry();

  // ---- preload dictionary into memory (a few thousand rows)
  const drugRes = await client.query("select ingredient_id, canonical_en from drugs");
  const nameRes = await client.query("select ingredient_id, surface_name, source from drug_names");
  const idMap = new Map<string, string>(); // DDInterNNNN -> ingredient_id
  for (const r of drugRes.rows) {
    const raw = String(r.ingredient_id);
    if (isStableId(raw) && !idMap.has(raw.toLowerCase())) idMap.set(raw.toLowerCase(), raw);
  }
  const nameMap = new Map<string, string[]>(); // lower(surfa ce) -> [existing ingredient_ids...]
  const sourceById = new Map<string, string>();
  for (const r of nameRes.rows) {
    const k = String(r.surface_name).toLowerCase();
    const arr = nameMap.get(k) ?? [];
    arr.push(String(r.ingredient_id));
    nameMap.set(k, arr);
    const s = String(r.source ?? "");
    if (/DDInter/i.test(s) && !sourceById.has(String(r.ingredient_id))) sourceById.set(String(r.ingredient_id), s);
  }
  t(`dictionary: drugs=${drugRes.rowCount} drug_names=${nameRes.rowCount} id-aliases=${idMap.size} names=${nameMap.size}`);

  // ---- resolution state
  const newNameSlug = new Map<string, string>(); // lower(name) in this run -> slug id
  const newNameOrig = new Map<string, string>(); // slug id -> original name
  const newSlugToName = new Map<string, string>();
  let exactHits = 0;
  let idHits = 0;
  let placeholderHits = 0;

  const canonicalForName = (origName: string): string => {
    const k = origName.toLowerCase();
    const existing = nameMap.get(k);
    if (existing && existing.length > 0) {
      // use the DDInter-sourced id when available; otherwise first
      const pref = existing.find((id) => sourceById.get(id)?.toLowerCase().includes("ddinter")) ?? existing[0];
      return pref;
    }
    return "";
  };

  const resolveId = (row: ResolvedRow, side: "A" | "B"): { id: string; ok: boolean } => {
    const idCol = side === "A" ? row.idA : row.idB;
    const name = side === "A" ? row.nameA : row.nameB;
    if (!name) return { id: "", ok: false };
    if (idCol && isStableId(idCol)) {
      const known = idMap.get(idCol.toLowerCase());
      if (known) {
        idHits++;
        return { id: known, ok: true };
      }
      // unknown stable id: materialise under the canonical DDInter id
      // (matches the repo convention that stable ids are ingredient_ids)
      if (!newNameSlug.has(idCol.toLowerCase())) {
        newNameSlug.set(idCol.toLowerCase(), idCol);
        newNameOrig.set(idCol, name);
        newSlugToName.set(idCol, name);
        placeholderHits++;
      }
      return { id: idCol, ok: true };
    }
    const k = name.toLowerCase();
    const existing = nameMap.get(k);
    if (existing && existing.length > 0) {
      exactHits++;
      return { id: canonicalForName(name), ok: true };
    }
    let slug = newNameSlug.get(k);
    if (!slug) {
      slug = slugify(name);
      // unique-ify against ids created this run
      const base = slug;
      let n = 2;
      while (newNameOrig.has(slug)) slug = `${base}-${n++}`;
      newNameSlug.set(k, slug);
      newNameOrig.set(slug, name);
      newSlugToName.set(slug, name);
      placeholderHits++;
    }
    return { id: slug, ok: true };
  };

  // ---- build pair rows (deduped unordered, max severity, first mechanism/source)
  interface PairRow {
    a: string;
    b: string;
    severity: string | null;
    mechanism: string | null;
    source: string | null;
  }
  const pairMap = new Map<string, PairRow>();
  let badRows = 0;
  let skippedSelf = 0;
  let lastLogAt = 0;
  src.rowsOut.forEach((row, idx) => {
    if (idx - lastLogAt >= 50000) {
      lastLogAt = Math.floor(idx / 50000) * 50000;
      t(`rows processed ${lastLogAt.toLocaleString()}`);
    }
    const ra = resolveId(row, "A");
    const rb = resolveId(row, "B");
    const na = row.nameA.trim();
    const nb = row.nameB.trim();
    // id-less single-CSV mode: if both names are missing/identical, use the
    // name itself as the pair key (deterministic, still idempotent)
    const keyAkey = ra.id && ra.ok ? ra.id : na;
    const keyBkey = rb.id && rb.ok ? rb.id : nb;
    if (!keyAkey || !keyBkey) {
      badRows++;
      return;
    }
    if (keyAkey === keyBkey) {
      skippedSelf++;
      return;
    }
    const a = keyAkey < keyBkey ? keyAkey : keyBkey;
    const b = keyAkey < keyBkey ? keyBkey : keyAkey;
    const sev = normSev(row.severity);
    const mech = row.mechanism;
    const srcv = row.source ?? null;
    const key = `${a}|${b}`;
    const prev = pairMap.get(key);
    if (!prev) pairMap.set(key, { a, b, severity: sev, mechanism: mech, source: srcv });
    else {
      if (sev && (!prev.severity || rank(sev) < rank(prev.severity) || (prev.severity === "Unknown" && sev !== "Unknown")))
        prev.severity = sev;
      if (!prev.mechanism && mech) prev.mechanism = mech;
      if (!prev.source && srcv) prev.source = srcv;
    }
  });
  t(
    `resolution: id-hit=${idHits.toLocaleString()} name-hit=${exactHits.toLocaleString()} placeholders=${placeholderHits.toLocaleString()} (distinct new names=${newNameOrig.size})`,
  );
  t(`pairs: unique=${pairMap.size.toLocaleString()} bad-rows=${badRows} self-pairs-skipped=${skippedSelf}`);

  if (limit !== Infinity) {
    t("--limit in effect: parse/test only, no DB writes");
    await client.end();
    return;
  }

  // ---- placeholders (drugs + drug_names), before pairs (FK)
  const placeholderIds = [...newNameOrig.keys()];
  if (placeholderIds.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < placeholderIds.length; i += BATCH) {
      const ids = placeholderIds.slice(i, i + BATCH);
      const vals = ids.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`);
      const params: string[] = [];
      for (const id of ids) params.push(id, newNameOrig.get(id) ?? id);
      await client.query(
        `insert into drugs (ingredient_id, canonical_en) values ${vals.join(", ")}
         on conflict (ingredient_id) do update set
           canonical_en = coalesce(nullif(drugs.canonical_en, ''), drugs.canonical_en, excluded.canonical_en)`,
        params,
      );
      const vals2 = ids.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, 'en', 'DDInter placeholder')`);
      const params2: string[] = [];
      for (const id of ids) params2.push(id, newNameOrig.get(id) ?? id);
      await client.query(
        `insert into drug_names (ingredient_id, surface_name, lang, source)
         values ${vals2.join(", ")}
         on conflict do nothing`,
        params2,
      );
    }
    t(`placeholders inserted: ${placeholderIds.length} drugs + drug_names rows (conflicts skipped)`);
  }

  // ---- ddi_pairs: skip what the DB already has, batch-insert the rest
  const pairRows = [...pairMap.values()];
  const preCounts = (
    await client.query(`select (select count(*) from ddi_pairs)::bigint p, (select count(*) from drugs)::bigint d, (select count(*) from drug_names)::bigint n`)
  ).rows[0] as { p: string; d: string; n: string };

  let toInsert = pairRows;
  let alreadyExisting = 0;
  if (pairRows.length > 0) {
    const aVals = pairRows.map((r) => r.a);
    const existingRes = await client.query(
      `select drug_a_ingredient, drug_b_ingredient from ddi_pairs
       where drug_a_ingredient = any($1::text[]) and drug_b_ingredient = any($2::text[])`,
      [aVals, pairRows.map((r) => r.b)],
    );
    const existing = new Set(
      existingRes.rows.map((r) => `${r.drug_a_ingredient}|${r.drug_b_ingredient}`),
    );
    const fresh = pairRows.filter((r) => !existing.has(`${r.a}|${r.b}`));
    t(
      `ddi_pairs: ${pairRows.length.toLocaleString()} candidates -> ${fresh.length.toLocaleString()} new, ${(pairRows.length - fresh.length).toLocaleString()} already in DB`,
    );
    alreadyExisting = pairRows.length - fresh.length;
    toInsert = fresh;
  }

  const BATCH = 2000;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    const vals = batch.map((_, j) => `($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5})`);
    const params: unknown[] = [];
    for (const p of batch) params.push(p.a, p.b, p.severity ?? "Unknown", p.mechanism, p.source ?? "DDInter 2.0");
    try {
      const res = await client.query(
        `insert into ddi_pairs (drug_a_ingredient, drug_b_ingredient, severity, mechanism_en, source)
         values ${vals.join(", ")}
         on conflict (drug_a_ingredient, drug_b_ingredient) do nothing`,
        params,
      );
      inserted += typeof res.rowCount === "number" ? res.rowCount : 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/socket|connection|terminated|ECONN|ETIMEDOUT|deadlock|lock/i.test(msg)) throw e;
      t(`insert batch failed (${msg}); reconnecting`);
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
      await connectWithRetry();
      const res = await client.query(
        `insert into ddi_pairs (drug_a_ingredient, drug_b_ingredient, severity, mechanism_en, source)
         values ${vals.join(", ")}
         on conflict (drug_a_ingredient, drug_b_ingredient) do nothing`,
        params,
      );
      inserted += typeof res.rowCount === "number" ? res.rowCount : 0;
    }
    const done = Math.min(i + BATCH, toInsert.length);
    if (done - lastLogAt >= 50000 || done === toInsert.length) {
      lastLogAt = done;
      t(`inserted ${inserted.toLocaleString()}/${toInsert.length.toLocaleString()} pairs`);
    }
  }

  const postCounts = (
    await client.query(`select (select count(*) from ddi_pairs)::bigint p, (select count(*) from drugs)::bigint d, (select count(*) from drug_names)::bigint n`)
  ).rows[0] as { p: string; d: string; n: string };
  const sevDist = (
    await client.query(`select severity, count(*)::int from ddi_pairs group by severity order by severity`)
  ).rows as { severity: string; count: number }[];

  await client.end();

  console.log("");
  console.log(`===== DDInter import summary (${src.mode}) =====`);
  console.log(`data rows read:            ${src.rowsOut.length.toLocaleString()}`);
  console.log(`  bad rows dropped:        ${badRows}`);
  console.log(`  self pairs skipped:      ${skippedSelf}`);
  console.log(`  unique candidates:       ${pairMap.size.toLocaleString()}`);
  console.log(`name resolution: id=${idHits.toLocaleString()} name=${exactHits.toLocaleString()} placeholder=${placeholderHits.toLocaleString()}`);
  console.log(
    `ddi_pairs: ${preCounts.p} -> ${postCounts.p} (added ${(Number(postCounts.p) - Number(preCounts.p)).toLocaleString()}, pre-filtered-as-existing ${alreadyExisting.toLocaleString()})`,
  );
  console.log(`drugs: ${preCounts.d} -> ${postCounts.d}`);
  console.log(`drug_names: ${preCounts.n} -> ${postCounts.n}`);
  console.log(`severity: ${sevDist.map((s) => `${s.severity}=${s.count.toLocaleString()}`).join(" ")}`);
  console.log(`db reconnect retries: ${retries}`);
  console.log("import: done — re-running must add 0 rows");
}

main().catch((e) => {
  console.error("IMPORT FAILED:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
