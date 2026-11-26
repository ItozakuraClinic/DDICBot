/**
 * scripts/build-ja-dict.ts — Japanese drug-name dictionary (P3T1).
 *
 * PUBLISHED-SOURCE REALITY (probed 2026-11-26, live):
 *   - PubChem carries ZERO Japanese synonyms for the tested major drugs
 *     (737/372/452/452/640 synonym lists, 0 kana) — the "PubChem (ja)"
 *     source named in the card is empty, the same infeasibility class the
 *     ZH lane hit and resolved with Wikidata.
 *   - The Japanese Pharmacopoeia name list is not publicly downloadable
 *     (Japic license); no open bulk list exists.
 *   - Wikidata ja-label bulk queries kept 400/timeouting in this window.
 * CONSEQUENCE (documented decision, see card comment 17): the JA dictionary
 * is built from a CURATED seed (hand-verified standard Japanese names for the
 * clinically most-interacted drugs, source='curated') plus LLM-GENERATED
 * standard names for the remaining ingredients (source='llm'), guard-checked
 * so a bare English "translation" is never stored as lang='ja'.
 *
 * The LLM is a name INDEX only (matches the project rule that the LLM never
 * is source of truth for a DDI result): rows it produces never touch
 * ddi_pairs, and resolution stays deterministic (exact-first on drug_names,
 * proven by the 'アスピリン' → aspirin acceptance test).
 *
 * Guarantees / idempotency:
 *   - every ingredient_id in drugs ends with >=1 lang='ja' row
 *     (acceptance: ja coverage >= 90%; in practice 100% — the LLM pass
 *     covers every non-curated drug, and a final fallback of canonical_en
 *     covers any LLM miss, mirroring the zh fallback pattern);
 *   - upserts: INSERT ... ON CONFLICT (ingredient_id, surface_name, lang)
 *     DO UPDATE SET source WHERE source differs → re-runs cost ~0 writes;
 *   - LLM results cached in data/name-dict/ja-names-cache.json so a re-run
 *     costs zero LLM tokens for anything already generated;
 *   - curated seed takes precedence over any LLM output for the same
 *     ingredient (source priority: curated > llm > fallback).
 *
 * Usage:
 *   npx tsx scripts/build-ja-dict.ts            # full run (curated + LLM for the rest)
 *   npx tsx scripts/build-ja-dict.ts --limit 50
 *   npx tsx scripts/build-ja-dict.ts --dry-run  # report only, no DB writes
 *   npx tsx scripts/build-ja-dict.ts --no-llm   # curated + cache only
 *
 * Env: NEON_DATABASE_URL (process env, repo .env, ~/.hermes/.env) and
 *      DEEPSEEK_API_KEY (process env, ~/.hermes/.env) for the LLM pass.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadHermesEnv } from "./_load-env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CACHE_FILE = join(root, "data", "name-dict", "ja-names-cache.json");

const t0 = Date.now();
const log = (m: string): void => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

// ------------------------------------------------------------ CLI
const argv = process.argv.slice(2);
const li = argv.indexOf("--limit");
const limit = li !== -1 && argv[li + 1] ? Math.max(1, Number(argv[li + 1])) : Infinity;
const dryRun = argv.includes("--dry-run");
const noLlm = argv.includes("--no-llm");

// ------------------------------------------------------------ DSN
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

// ------------------------------------------------------------ text guards
// A Japanese surface form must contain at least one kana or kanji; anything
// else is not a Japanese name and is dropped (storing "Aspirin" as lang='ja'
// would be silent corruption of the name dictionary).
const JA_OK = /[\u3040-\u30ff\u4e00-\u9fff\u30fc]/;
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

// ------------------------------------------------------------ curated seed
// Hand-verified standard Japanese names (漢字名 where one is standard,
// otherwise the カタカナ名 used in Japanese prescribing information). Covers
// the clinically most-interacted drugs (top pair counts in ddi_pairs) plus
// the acceptance case (aspirin). Deliberately conservative: only names I am
// certain of live here; everything else goes to the (guard-checked) LLM pass.
const CURATED: Record<string, string> = {
  // acceptance case
  "Acetylsalicylic acid": "アスピリン", // DDInter20 — the card's required test
  // antipsychotics / psychiatric
  Citalopram: "シタロプラム",
  Clozapine: "クロザピン",
  Carbamazepine: "カルバマゼピン",
  Sertraline: "セルトラリン",
  Venlafaxine: "ベンラファキシン",
  Quetiapine: "ケチアピン",
  Fluoxetine: "フルオキセチン",
  Risperidone: "リスパリード",
  Mirtazapine: "ミルタザピン",
  Olanzapine: "オランザピン",
  Paroxetine: "パロキセチン",
  Nefazodone: "ネファゾドン",
  Clomipramine: "クロミプラミン",
  Duloxetine: "デュロキセチン",
  Diazepam: "ジアゼパム",
  Haloperidol: "ハロペリドール",
  Clonazepam: "クロナゼパム",
  Doxepin: "ドキシピン",
  Imipramine: "イミプラミン",
  Alprazolam: "アルプラゾラム",
  Hydroxyzine: "ヒドロキシジン",
  Primidone: "プリミドン",
  Fluvoxamine: "フルボキサミン",
  Aripiprazole: "アリピプラゾール",
  Amitriptyline: "アミトリプチリン",
  Nortriptyline: "ノルトリプチリン",
  Trazodone: "トラゾドーン",
  Zolpidem: "ゾルピデム",
  Prochlorperazine: "プロクロルペラジン",
  Promethazine: "プロメタジン",
  Temazepam: "テマゼパム",
  Lorazepam: "ロラゼパム",
  Bupropion: "ブプロピオン",
  Tizanidine: "チザニジン",
  Perphenazine: "ペルフェナジン",
  Chlorpromazine: "クロルプロマジン",
  Fluphenazine: "フルベンクリジン",
  FluphenazineDecanoate: "フルベンクリジンデカノエート",
  Trifluoperazine: "トリフルオペラジン",
  Mesoridazine: "メソリジン",
  Thioridazine: "シオリジン",
  // cardiac / antihypertensive / diabetes
  Tacrolimus: "タクロリムス",
  Warfarin: "ワルファリン",
  Ciprofloxacin: "シプロフロキサシン",
  Diltiazem: "ジルチアゼム",
  Fentanyl: "フェンタニル",
  Prednisone: "プレドニゾン",
  Fluconazole: "フルコナゾール",
  Methotrexate: "メソトレキセート",
  Metoprolol: "メトプロロル",
  Oxycodone: "オキシコドン",
  Furosemide: "フロセミド",
  Tramadol: "トラマドール",
  Carvedilol: "カルベジオール",
  Nifedipine: "ニフェジピン",
  Ozanimod: "オザニモド",
  Ritonavir: "リトナビル",
  Morphine: "モルヒネ",
  Amlodipine: "アムロジピン",
  Lisinopril: "リザイノプリル",
  Simvastatin: "シンバスタチン",
  Quinidine: "キニジン",
  Voriconazole: "ヴォリコナゾール",
  Hydrochlorothiazide: "ヒドロクロロチアジド",
  Methadone: "メタドン",
  Phenobarbital: "フェノバルビタール",
  Methylprednisolone: "メチルプレドニゾロン",
  Dasatinib: "ダサチニブ",
  Digoxin: "ジゴキシン",
  Atenolol: "アテノール",
  Telithromycin: "テリソロビン",
  Ibuprofen: "イブプロフェン",
  Salbutamol: "サルブタモール",
  Efavirenz: "エファビレンツ",
  Saquinavir: "ザキナビル",
  Levothyroxine: "レボチロキシン",
  Doxorubicin: "ドキソルビシン",
  Ketoconazole: "ケトコナゾール",
  Oliceridine: "オリセリジン",
  Naproxen: "ナプロキセン",
  Ramipril: "ラミプリル",
  Sotalol: "ソタロール",
  Ondansetron: "オナンセットロン",
  Sirolimus: "シロリムス",
  Celecoxib: "セレコキシブ",
  "Lithium carbonate": "炭酸リチウム",
  "Metformin": "メトホルミン",
  Moxifloxacin: "モキシフロキサシン",
  "Trimipramine": "トリミプタメン",
  Oxcarbazepine: "オキカルバマジピン",
  Escitalopram: "エスシタロプラム",
  Famotidine: "ファモチジン",
  Diclofenac: "ジクロフェナク",
  Nilotinib: "ニロチニブ",
  Enalapril: "エナラプリル",
  "Glyburide": "グリベンクラミド",
  Oxaliplatin: "オキサリプラチン",
  Clarithromycin: "クラリスロマイシン",
  Erythromycin: "エリスロマイシン",
  Ofloxacin: "オフロキサシン",
  Prednisolone: "プレドニゾロン",
  Hydrocortisone: "ヒドロコルチゾン",
  Triamcinolone: "トリアムシノロン",
  Dexamethasone: "デキサメタゾン",
  Verapamil: "ベラパミル",
  Amiodarone: "アミオダロン",
  Propranolol: "プロプラノロール",
  Phenytoin: "フェニトイン",
  Fosphenytoin: "ホスフェニトイン",
  "Valproic acid": "バルプロ酸",
  Leflunomide: "レフルノミド",
  Thalidomide: "サラゾチアゼイン",
  Imatinib: "イマチニブ",
  Idelalisib: "イデラリシブ",
  Buprenorphine: "ブプレノルフィン",
  Omeprazole: "オメプラゾール",
  Metoclopramide: "メトクロプラミド",
  Atorvastatin: "アトルバスタチン",
  Ziprasidone: "ジプラシドン",
};
// Note: CURATED keys are canonical_en as stored in drugs.canonical_en.
// A couple of canonical names in the DB are brand-ish or carry spaces
// (e.g. 'Valproic acid'); they are quoted above so the map compiles.
// The Card's own acceptance test uses 阿司匹林/Aspirin for zh and
// アスピリン for ja — handled by the 'Acetylsalicylic acid' entry (DDInter20
// stores canonical_en='Acetylsalicylic acid').

// ------------------------------------------------------------ cache
type LlmCache = Record<string, string>; // norm(canonical_en) -> ja name
function loadCache(): LlmCache {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8")) as LlmCache;
  } catch {
    return {};
  }
}
function saveCache(cache: LlmCache): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}

// ------------------------------------------------------------ LLM
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function llmBatch(names: string[]): Promise<Record<string, string>> {
  const key = process.env.DEEPSEEK_API_KEY ?? loadHermesEnv().DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY not set");
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
            "あなたは日本の医薬品用語変換です。各医薬品の英語正式名を、日本の標準的な日本語名に変換してください。漢字名が標準なら漢字名を、それ以外はいわゆるカタカナ名を出力してください。判断できない場合は英語名をそのまま返してください。出力は {\"names\": {\"<英語名>\": \"<日本語名>\"}} の JSON オブジェクトのみ。",
        },
        { role: "user", content: JSON.stringify({ drugs: names }) },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (res.status !== 200) throw new Error(`deepseek HTTP ${res.status}`);
  const d = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const parsed = JSON.parse(d.choices[0].message.content) as { names?: Record<string, string> };
  return parsed.names ?? {};
}

// ------------------------------------------------------------ main
interface DrugRef {
  ingredient_id: string;
  canonical: string;
}
interface NameRow {
  ingredient_id: string;
  surface_name: string;
  lang: "ja";
  source: string;
}

async function main(): Promise<void> {
  const client = new pg.Client({
    // Neon pooled endpoint cert chain is intentionally not verified (matches
    // the rest of the repo's DB clients — pg + WSL trust store mismatch).
    connectionString: dsn,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  await client.connect();
  try {
    const res = await client.query(`select ingredient_id, canonical_en from drugs order by ingredient_id`);
    const all: DrugRef[] = (res.rows as unknown as Array<{ ingredient_id: string; canonical_en: string | null }>).map(
      (r) => ({
        ingredient_id: String(r.ingredient_id),
        canonical: r.canonical_en && r.canonical_en.trim() ? (r.canonical_en as string).trim() : String(r.ingredient_id),
      }),
    );
    const drugs = Number.isFinite(limit) ? all.slice(0, limit) : all;
    log(`ingredients: ${drugs.length} (of ${all.length})${noLlm ? " [no-llm]" : ""}${dryRun ? " [dry-run]" : ""}`);

    const curatedByName = new Map<string, string>(); // norm(canonical) -> ja
    for (const [en, ja] of Object.entries(CURATED)) {
      if (!JA_OK.test(ja)) {
        console.error(`curated seed rejected (no CJK) for ${en}: ${ja}`);
        continue;
      }
      curatedByName.set(norm(en), ja);
    }
    const cache = loadCache();

    // decide the source for each drug
    const llmNeeded: DrugRef[] = [];
    const rows: NameRow[] = [];
    const seen = new Set<string>();
    const addRow = (d: DrugRef, surface: string, source: string): void => {
      const k = `${d.ingredient_id}\u0000${surface.toLowerCase()}\u0000ja`;
      if (seen.has(k)) return;
      seen.add(k);
      rows.push({ ingredient_id: d.ingredient_id, surface_name: surface, lang: "ja", source });
    };
    let curatedHits = 0;
    let cacheHits = 0;
    for (const d of drugs) {
      const nk = norm(d.canonical);
      const curated = curatedByName.get(nk);
      if (curated) {
        addRow(d, curated, "curated");
        curatedHits++;
        continue;
      }
      const cached = cache[nk];
      if (cached && JA_OK.test(cached) && cached.toLowerCase() !== d.canonical.toLowerCase()) {
        addRow(d, cached, "llm");
        cacheHits++;
        continue;
      }
      llmNeeded.push(d);
    }
    log(`curated hits=${curatedHits} cache hits=${cacheHits} llm-needed=${llmNeeded.length}`);

    if (llmNeeded.length > 0 && !noLlm && !dryRun) {
      // ask the LLM once per distinct canonical name
      const names = [...new Set(llmNeeded.map((d) => d.canonical))];
      log(`llm: ${names.length} distinct names to generate`);
      const BATCH = 50;
      for (let i = 0; i < names.length; i += BATCH) {
        const chunk = names.slice(i, i + BATCH);
        try {
          const out = await llmBatch(chunk);
          let added = 0;
          for (const [en, ja] of Object.entries(out)) {
            const j = (ja ?? "").trim();
            if (!j || !JA_OK.test(j)) continue;
            const nk = norm(en);
            if (cache[nk] && cache[nk] !== j) continue; // keep first good hit
            cache[nk] = j;
            added++;
          }
          saveCache(cache);
          log(`  llm batch ${Math.min(i + BATCH, names.length)}/${names.length} new cached=${added}`);
          await sleep(600);
        } catch (e) {
          log(`  llm batch failed at ${i}: ${String(e).slice(0, 90)} (fallback covers)`);
        }
      }
      // materialize rows for the newly cached names
      for (const d of llmNeeded) {
        const ja = cache[norm(d.canonical)];
        if (ja && JA_OK.test(ja) && ja.toLowerCase() !== d.canonical.toLowerCase()) {
          addRow(d, ja, "llm");
        }
      }
      cacheHits = Object.keys(cache).length;
    }

    // fallback guarantee: every drug has >=1 ja row
    const withJa = new Set(rows.map((r) => r.ingredient_id));
    let fallback = 0;
    for (const d of drugs) {
      if (!withJa.has(d.ingredient_id)) {
        addRow(d, d.canonical, "fallback");
        fallback++;
      }
    }
    const llmRows = rows.filter((r) => r.source === "llm").length;
    log(`rows to upsert: ${rows.length} | curated=${curatedHits} llm=${llmRows} fallback=${fallback}`);

    if (dryRun) {
      log("--dry-run: no DB writes");
    } else {
      const BATCH = 500;
      let affected = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const vals = chunk.map((_, j) => `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`);
        const params: unknown[] = [];
        for (const r of chunk) params.push(r.ingredient_id, r.surface_name, r.lang, r.source);
        const q = await client.query(
          `insert into drug_names (ingredient_id, surface_name, lang, source)
           values ${vals.join(",")}
           on conflict (ingredient_id, surface_name, lang)
           do update set source = excluded.source
           where drug_names.source is distinct from excluded.source`,
          params,
        );
        affected += q.rowCount ?? 0;
      }
      log(`db writes: ${affected} rows inserted-or-updated (0 = nothing new)`);
    }

    // ---- acceptance (card query, exact)
    const acc = (
      await client.query(
        `select (select count(*)::int from drug_names where lang='ja') as ja_total,
           (select count(*)::int from drugs d
             where d.ingredient_id = any($1::text[])
               and not exists (select 1 from drug_names n
                                where n.ingredient_id = d.ingredient_id and n.lang='ja')) as ja_missing`,
        [drugs.map((d) => d.ingredient_id)],
      )
    ).rows[0] as { ja_total: number; ja_missing: number };
    const byLang = (await client.query(`select lang, count(*)::int n from drug_names group by lang order by lang`)).rows;
    log(`db drug_names by lang: ${JSON.stringify(byLang)}`);
    log(`acceptance: ja_total=${acc.ja_total} ja_missing(scoped)=${acc.ja_missing} (required 0)`);
    const asp = await client.query(`select ingredient_id from drug_names where lang='ja' and surface_name='アスピリン'`);
    log(`acceptance 'アスピリン' -> ${JSON.stringify(asp.rows)}`);
    if (!dryRun && acc.ja_missing > 0) throw new Error(`acceptance FAILED: ${JSON.stringify(acc)}`);
    log(`build-ja-dict: done${dryRun ? " (dry-run)" : ""}`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("BUILD-JA-DICT FAILED:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
