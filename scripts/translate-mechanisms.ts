/**
 * scripts/translate-mechanisms.ts — LLM mechanism translation (P3T2).
 *
 * Fills ddi_pairs.mechanism_zh / ddi_pairs.mechanism_ja from mechanism_en
 * using the LLM as a translation layer ONLY. The DB is the cache: rows with
 * mechanism_en present but mechanism_zh NULL are the untranslated set, so a
 * re-run touches exactly the rows not yet translated (idempotent). The LLM
 * never touches severity, pair membership, or mechanism_en — it writes two
 * new TEXT columns and nothing else.
 *
 * Batches of N distinct mechanism_en values go per LLM call (JSON mode,
 * temperature 0); the response is re-keyed back to each pair and written
 * per-row so a partial batch failure loses only that row, not the batch.
 *
 * Usage:
 *   npx tsx scripts/translate-mechanisms.ts               # all pending pairs
 *   npx tsx scripts/translate-mechanisms.ts --limit 50    # first 50 pending (acceptance sample)
 *   npx tsx scripts/translate-mechanisms.ts --dry-run     # report set, no writes
 *
 * Env: NEON_DATABASE_URL + DEEPSEEK_API_KEY (process env / repo .env /
 *      ~/.hermes/.env — never hardcoded).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadHermesEnv } from "./_load-env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const argv = process.argv.slice(2);
const li = argv.indexOf("--limit");
const limit = li !== -1 && argv[li + 1] ? Math.max(1, Number(argv[li + 1])) : Infinity;
const dryRun = argv.includes("--dry-run");
const BATCH = 20;

const t0 = Date.now();
const log = (m: string): void => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

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
const key = process.env.DEEPSEEK_API_KEY ?? loadHermesEnv().DEEPSEEK_API_KEY;
if (!key && !dryRun) {
  console.error("DEEPSEEK_API_KEY not resolved");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pending {
  id: number;
  a: string;
  b: string;
  en: string;
}

async function llmTranslate(enTexts: string[]): Promise<Record<string, { zh: string; ja: string }>> {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是药物相互作用机制的专业翻译。把每条英文机制准确翻译成简体中文和日文（使用规范的医学/药学用语，忠于原文，不增删信息）。按输入顺序输出 JSON：{\"out\":[{\"zh\":\"...\",\"ja\":\"...\"}, ...]}，数组长度必须与输入条数一致。",
        },
        { role: "user", content: JSON.stringify({ mechanisms: enTexts, n: enTexts.length }) },
      ],
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (res.status !== 200) throw new Error(`deepseek HTTP ${res.status}`);
  const d = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const parsed = JSON.parse(d.choices[0].message.content) as { out?: Array<{ zh?: string; ja?: string }> };
  const map: Record<string, { zh: string; ja: string }> = {};
  for (let i = 0; i < enTexts.length; i++) {
    const item = parsed.out?.[i];
    map[enTexts[i]] = {
      zh: (item?.zh ?? "").trim(),
      ja: (item?.ja ?? "").trim(),
    };
  }
  return map;
}

// Neon's pooler drops idle/pooled connections: the LLM phase idles the
// connection for minutes (up to 2 minutes per batch), so the pooled DSN's
// connection is usually dead by the time the write phase starts — both runs
// that preceded this fix lost the whole accumulated result to that one dead
// connection. Strategy: a factory that hands out a FRESH client per work
// phase (pg clients cannot be reconnected after end()) and PER-BATCH writes,
// so a crash at any point loses at most one batch of ~20 texts.
function openDb(): pg.Client {
  const c = new pg.Client({
    connectionString: dsn,
    // Repo-wide Neon pooled-DSN convention (sslmode=require already in DSN;
    // pg's strict sslmode default needs the explicit accept flag).
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
    query_timeout: 180000,
  });
  // A server-side disconnect emits 'error' asynchronously; without a handler
  // the process would crash on the next idle drop. Logged here; each phase
  // opens its own client, so recovery is a new db() call, not a reconnect.
  c.on("error", (e) => log(`pg client error: ${String(e.message ?? e)}`));
  return c;
}

async function db<T>(work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = openDb();
  try {
    await c.connect();
    return await work(c);
  } finally {
    await c.end().catch(() => {});
  }
}

async function main(): Promise<void> {
  const before = (await db((c) => c.query(`select count(*)::int n from ddi_pairs where mechanism_en is not null`))).rows[0]
    .n as number;
  const pendingRes = await db((c) =>
    c.query(
      `select id, drug_a_ingredient as a, drug_b_ingredient as b, mechanism_en as en
       from ddi_pairs
       where mechanism_en is not null and btrim(coalesce(mechanism_en,'')) <> ''
         and (mechanism_zh is null or btrim(mechanism_zh) = '')
       order by id
       ${Number.isFinite(limit) ? `limit ${Math.floor(limit)}` : ""}`,
    ),
  );
  const pending: Pending[] = pendingRes.rows as Pending[];
  log(`pairs with mechanism_en=${before}; pending translation=${pending.length}`);

  if (dryRun) {
    log("--dry-run: no LLM / no writes");
  }
  if (pending.length === 0) {
    log("nothing to translate — already complete (idempotent)");
    log(`summary: before=${before} pending=0 written=0`);
    return;
  }

  // distinct EN texts (many pairs share the same mechanism wording)
  const distinct = new Map<string, number[]>(); // en -> [ids]
  for (const p of pending) {
    const arr = distinct.get(p.en) ?? [];
    arr.push(p.id);
    distinct.set(p.en, arr);
  }
  const texts = [...distinct.keys()];
  log(`distinct mechanism_en=${texts.length} (shared across ${pending.length} pairs)`);

  let translatedEn = 0;
  let skippedBlank = 0;
  let batchCalls = 0;
  let written = 0;
  const writeRows = (rows: Array<{ id: number; zh: string; ja: string }>): Promise<void> =>
    db((c) => {
      const vals = rows.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`);
      const params: unknown[] = [];
      for (const r of rows) params.push(r.id, r.zh || null, r.ja || null);
      return c
        .query(
          // Bare FROM-(values) shape: `with up as (values …)` + a column alias
          // after the closing paren is a PG syntax error (verified on PG 18.7).
          // id arrives as text from values; cast to match ddi_pairs.id (bigint).
          `update ddi_pairs p
              set mechanism_zh = coalesce(p.mechanism_zh, v.zh),
                  mechanism_ja = coalesce(p.mechanism_ja, v.ja)
            from (values ${vals.join(",")}) v(id, zh, ja)
           where p.id = v.id::bigint`,
          params,
        )
        .then((q) => {
          written += q.rowCount ?? 0;
        });
    });

  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    try {
      const map = await llmTranslate(chunk);
      const batchRows: Array<{ id: number; zh: string; ja: string }> = [];
      for (const en of chunk) {
        const r = map[en] ?? { zh: "", ja: "" };
        if (!r.zh && !r.ja) {
          skippedBlank++;
          continue;
        }
        for (const id of distinct.get(en)!) batchRows.push({ id, zh: r.zh, ja: r.ja });
        translatedEn++;
      }
      batchCalls++;
      // Persist each batch immediately: the LLM phase is the long, fragile
      // part, and a crash must cost at most one batch, never the whole run.
      // Only still-empty columns are filled (coalesce), so a re-run never
      // clobbers prior output.
      if (!dryRun && batchRows.length > 0) await writeRows(batchRows);
      if (batchCalls % 5 === 0) log(`  translated+persisted ${Math.min(i + BATCH, texts.length)}/${texts.length} en (db=${written})`);
      await sleep(500);
    } catch (e) {
      log(`  batch ${i} failed: ${String(e).slice(0, 90)} (those pairs stay pending for next run)`);
    }
  }

  if (dryRun) log(`dry-run: no writes performed`);
  else log(`db writes: ${written} pairs updated (zh/ja)`);

  const acc = (
    await db((c) =>
      c.query(
        `select
          (select count(*)::int from ddi_pairs where mechanism_en is not null) en,
          (select count(*)::int from ddi_pairs where mechanism_zh is not null and btrim(mechanism_zh) <> '') zh,
          (select count(*)::int from ddi_pairs where mechanism_ja is not null and btrim(mechanism_ja) <> '') ja`,
      ),
    )
  ).rows[0] as { en: number; zh: number; ja: number };
  log(`summary: mechanism_en=${acc.en} mechanism_zh=${acc.zh} mechanism_ja=${acc.ja}`);
  log(`stats: distinct en translated=${translatedEn} blank/dropped=${skippedBlank} batchCalls=${batchCalls} dbRowsWritten=${written}`);
  // Acceptance sample (first persisted in id order) for the spot-check record.
  if (!dryRun && written > 0) {
    const sample = (
      await db((c) =>
        c.query(
          `select mechanism_en, mechanism_zh, mechanism_ja from ddi_pairs
           where mechanism_zh is not null order by id limit 3`,
        ),
      )
    ).rows as Array<{ mechanism_en: string; mechanism_zh: string; mechanism_ja: string }>;
    log("translate-mechanisms: done. sample (en→zh/ja):");
    for (const s of sample) {
      log(`  EN: ${s.mechanism_en.slice(0, 70)}…`);
      log(`  ZH: ${(s.mechanism_zh ?? "").slice(0, 70)}…`);
      log(`  JA: ${(s.mechanism_ja ?? "").slice(0, 70)}…`);
    }
  } else {
    log("translate-mechanisms: done");
  }
}

main().catch((e) => {
  console.error("TRANSLATE-MECHANISMS FAILED:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
