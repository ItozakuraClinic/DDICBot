import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel cron trigger + bounded in-window work (see handler notes below).
export const maxDuration = 60;

/**
 * POST/GET /api/cron/refresh — authenticated periodic data refresh (P3T3).
 *
 * AUTH: Vercel Cron automatically sends `Authorization: Bearer <CRON_SECRET>`
 * for cron-triggered requests (the CRON_SECRET env var is Vercel's source of
 * truth). `?secret=` is additionally accepted for manual verification
 * (acceptance: 200 with CRON_SECRET, 401 without). Constant-time compare.
 *
 * WHAT RUNS (all idempotent — re-running any stage is a no-op or a bounded
 * catch-up, never a double-apply):
 *   - This runtime HAS the DDInter CSVs (local dev / self-hosted, data/ddinter/
 *     present): dispatches scripts/daily-refresh.ts as a DETACHED child
 *     process (bundle download check → idempotent import → mechanism EN
 *     backfill → LLM translate) and returns a receipt immediately — the
 *     minutes-long pipeline cannot run inside a function window, and the
 *     script logs its own row counts before/after each stage.
 *   - This runtime does NOT have the CSVs (Vercel prod — data/ is kept off the
 *     Vercel bundle by .vercelignore): performs the bounded DB-side catch-ups
 *     directly:
 *       1. FK reconciliation — every ingredient referenced by ddi_pairs has a
 *          drugs row (INSERT ... ON CONFLICT DO NOTHING).
 *       2. Mechanism translation catch-up — up to one batch (20 distinct
 *          untranslated mechanism_en texts) is translated to zh/ja via the LLM
 *          when DEEPSEEK_API_KEY is configured (translation layer only; the
 *          LLM never touches severity/pair membership).
 *       3. JA name-dict catch-up — drugs without a lang='ja' row get one from
 *          the LLM (CJK-guarded, source='llm'), up to 20 names per run.
 *     Row counts are logged before/after every stage.
 *
 * The full daily pipeline (CSV download + import + 8.4k-page mechanism crawl)
 * lives in scripts/daily-refresh.ts for the machine that owns data/.
 *
 * SECURITY: photos/PII never pass through here; only DB maintenance. The
 * response JSON is operator-facing and secret-free.
 */

const CJK = /[\u3040-\u30ff\u4e00-\u9fff\u30fc]/;
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

function timingsEqual(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization");
  if (header) {
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) return timingsEqual(m[1].trim(), secret);
  }
  const q = new URL(req.url).searchParams.get("secret");
  if (q) return timingsEqual(q, secret);
  return false;
}

type Counts = {
  drugs: number;
  ddi_pairs: number;
  names_en: number;
  names_zh: number;
  names_ja: number;
  mech_en: number;
  mech_zh: number;
  mech_ja: number;
};

async function counts(pool: ReturnType<typeof getPool>): Promise<Counts> {
  const r = (
    await pool.query(
      `select
        (select count(*)::int from drugs) drugs,
        (select count(*)::int from ddi_pairs) ddi_pairs,
        (select count(*)::int from drug_names where lang='en') names_en,
        (select count(*)::int from drug_names where lang='zh') names_zh,
        (select count(*)::int from drug_names where lang='ja') names_ja,
        (select count(*)::int from ddi_pairs where mechanism_en is not null and btrim(mechanism_en) <> '') mech_en,
        (select count(*)::int from ddi_pairs where mechanism_zh is not null and btrim(mechanism_zh) <> '') mech_zh,
        (select count(*)::int from ddi_pairs where mechanism_ja is not null and btrim(mechanism_ja) <> '') mech_ja`,
    )
  ).rows[0] as Counts;
  return r;
}

/** FK reconciliation: drugs rows for every ingredient referenced by pairs. */
async function reconcileDrugFk(pool: ReturnType<typeof getPool>): Promise<number> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `insert into drugs (ingredient_id, canonical_en)
       select distinct v.ing, v.ing
       from (
         select drug_a_ingredient as ing from ddi_pairs
         union
         select drug_b_ingredient from ddi_pairs
       ) v
       left join drugs d on d.ingredient_id = v.ing
       where d.ingredient_id is null
       on conflict (ingredient_id) do nothing`,
    );
    return res.rowCount ?? 0;
  } finally {
    client.release();
  }
}

/** LLM translation of up to one batch of untranslated mechanism texts. */
async function translateCatchUp(pool: ReturnType<typeof getPool>, report: Record<string, unknown>): Promise<void> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    report.translate = "skipped (DEEPSEEK_API_KEY not set on this runtime)";
    return;
  }
  const client = await pool.connect();
  try {
    const pending = await client.query(
      `select mechanism_en as en
       from ddi_pairs
       where mechanism_en is not null and btrim(mechanism_en) <> ''
         and (mechanism_zh is null or btrim(mechanism_zh) = '')
       order by id limit 20`,
    );
    const texts = [...new Set(pending.rows.map((r) => r.en as string))];
    if (texts.length === 0) {
      report.translate = "no pending rows — nothing to do (idempotent)";
      return;
    }
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
              "你是药物相互作用机制的专业翻译。把每条英文机制准确翻译成简体中文和日文（规范医学/药学用语，忠于原文，不增删信息）。输出 JSON：{\"out\":[{\"zh\":\"...\",\"ja\":\"...\"}, ...]}，数组长度与输入一致。",
          },
          { role: "user", content: JSON.stringify({ mechanisms: texts, n: texts.length }) },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      report.translate = `llm HTTP ${res.status} (no rows changed; next run retries)`;
      return;
    }
    const d = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const parsed = JSON.parse(d.choices[0].message.content) as { out?: Array<{ zh?: string; ja?: string }> };
    let written = 0;
    for (let i = 0; i < texts.length; i++) {
      const item = parsed.out?.[i];
      const zh = (item?.zh ?? "").trim();
      const ja = (item?.ja ?? "").trim();
      if (!zh && !ja) continue;
      const q = await client.query(
        `update ddi_pairs p
            set mechanism_zh = coalesce(p.mechanism_zh, $2),
                mechanism_ja = coalesce(p.mechanism_ja, $3)
         where p.mechanism_en = $1
           and (p.mechanism_zh is null or btrim(p.mechanism_zh) = '')`,
        [texts[i], zh || null, ja || null],
      );
      written += q.rowCount ?? 0;
    }
    report.translate = `translated batch=${texts.length} rows updated=${written}`;
  } finally {
    client.release();
  }
}

/** JA name-dict catch-up: ensure every drug has >=1 lang='ja' row. */
async function jaDictCatchUp(pool: ReturnType<typeof getPool>, report: Record<string, unknown>): Promise<void> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    report.ja_dict = "skipped (DEEPSEEK_API_KEY not set on this runtime)";
    return;
  }
  const client = await pool.connect();
  try {
    const missing = await client.query(
      `select d.ingredient_id, coalesce(nullif(d.canonical_en, ''), d.ingredient_id) as en
       from drugs d
       where not exists (select 1 from drug_names n
                          where n.ingredient_id = d.ingredient_id and n.lang='ja')
       order by d.ingredient_id limit 20`,
    );
    if (missing.rowCount === 0) {
      report.ja_dict = "full coverage — nothing to do (idempotent)";
      return;
    }
    const rows = missing.rows as Array<{ ingredient_id: string; en: string }>;
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
              "あなたは日本の医薬品用語変換です。各薬物の英語正式名を日本の標準的な日本語名に変換してください。漢字名が標準なら漢字名を、それ以外はカタカナ名で。判断できない場合は英語名のまま返す。出力は {\"names\": {\"<英語名>\": \"<日本語名>\"}} の JSON のみ。",
          },
          { role: "user", content: JSON.stringify({ drugs: rows.map((r) => r.en) }) },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      report.ja_dict = `llm HTTP ${res.status} (no rows changed; next run retries)`;
      return;
    }
    const d = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const names = (JSON.parse(d.choices[0].message.content) as { names?: Record<string, string> }).names ?? {};
    let written = 0;
    for (const r of rows) {
      const ja = (names[r.en] ?? "").trim();
      // CJK guard: never store a bare English string as lang='ja'.
      if (!ja || !CJK.test(ja)) continue;
      const q = await client.query(
        `insert into drug_names (ingredient_id, surface_name, lang, source)
         values ($1, $2, 'ja', 'llm')
         on conflict (ingredient_id, surface_name, lang) do nothing`,
        [r.ingredient_id, ja],
      );
      written += q.rowCount ?? 0;
    }
    report.ja_dict = `candidates=${rows.length} inserted=${written}`;
  } finally {
    client.release();
  }
}

async function handler(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  const started = Date.now();
  const report: Record<string, unknown> = { status: "ok", started_unix_ms: started };
  const before = await counts(pool);
  report.counts_before = before;

  const dataDir = "data/ddinter";
  let csvPresent = false;
  if (process.env.DDINTER_SKIP_FULL_PIPELINE) {
    // Test/ops override: force the bounded DB-catchup path even when CSVs
    // are present locally (acceptance testing without a 30-min crawl).
    csvPresent = false;
  } else {
    try {
      const { readdirSync, existsSync } = await import("node:fs");
      csvPresent =
        existsSync(dataDir) &&
        readdirSync(dataDir).some((f) => /^ddinter_downloads_code_[A-Z]\.csv$/.test(f));
    } catch {
      csvPresent = false;
    }
  }

  if (csvPresent) {
    // Full pipeline in a DETACHED child process (local/self-hosted runtime).
    // The pipeline (bundle check → import → mechanism backfill → translate)
    // runs for minutes — it will not fit inside any Vercel function window,
    // and a bounded wait here is how the earlier 50s-blocking design
    // misreported healthy runs as failures. We dispatch detach, return the
    // receipt immediately, and let the idempotent script log its own
    // before/after counts. Re-dispatching while a run is in flight is safe:
    // every stage is guarded (ON CONFLICT DO NOTHING / NULL-column skips),
    // so worst case is duplicate LLM tokens, never duplicate rows.
    report.mode = "full-pipeline-dispatched";
    const { spawn } = await import("node:child_process");
    const { join } = await import("node:path");
    const child = spawn("npx", ["tsx", join(process.cwd(), "scripts", "daily-refresh.ts")], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    report.pid = child.pid ?? null;
    report.note = "daily-refresh.ts running detached; its stdout logs the stage rows before/after";
  } else {
    // Bounded DB-side catch-ups (Vercel prod runtime; CSVs are not bundled).
    report.mode = "db-catchup";
    const fkAdded = await reconcileDrugFk(pool);
    report.fk_reconcile = `drugs rows added=${fkAdded}`;
    await translateCatchUp(pool, report);
    await jaDictCatchUp(pool, report);
  }

  const after = await counts(pool);
  report.counts_after = after;
  report.elapsed_ms = Date.now() - started;
  console.log(`[cron/refresh] ${report.mode} elapsed=${report.elapsed_ms}ms before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  return Response.json(report);
}

export async function POST(req: Request): Promise<Response> {
  return handler(req);
}
export async function GET(req: Request): Promise<Response> {
  // GET is for manual verification of the auth contract (401/200); the
  // Vercel cron itself sends POST.
  return handler(req);
}
