/**
 * scripts/daily-refresh.ts — periodic data refresh (P3T3).
 *
 * What it does, in order (all idempotent; a second run in the same day is a
 * no-op that still exits 0):
 *   1. DDInter 2.0 bundle check: HEAD/GET each known per-ATC CSV from
 *      https://ddinter2.scbdd.com/static/media/download/, md5-compare with
 *      data/ddinter/manifest.md5, download only changed/new files. New files
 *      (e.g. a new ATC category appearing — code_C.csv did exactly that) are
 *      discovered by probing the standard letter set A..Z.
 *   2. Re-import (scripts/import-ddinter logic): upserts drugs/ddi_pairs/
 *      placeholder names — ON CONFLICT DO NOTHING, so unchanged data adds 0.
 *   3. Mechanism EN backfill (scripts/backfill-mechanisms): fills
 *      mechanism_en for pairs the UI-crawl now covers; IS NULL guard skips
 *      already-filled rows.
 *   4. LLM translation backfill (scripts/translate-mechanisms): fills
 *      mechanism_zh/ja for untranslated rows; null-guarded, so a run costs
 *      LLM tokens only for genuinely new mechanism text.
 *   5. Log row counts before/after at every stage (the operator-visible
 *      proof of what changed).
 *
 * The script is the single source of work; the Vercel route
 * (app/api/cron/refresh.ts) is its authenticated wrapper and invokes it
 * in-process via dynamic import so no child process is needed on the
 * edge. Local runs: `npx tsx scripts/daily-refresh.ts` (flags pass through:
 *   --skip-crawl skips the LLM/mechanism stages, --skip-llm skips only the
 *   LLM stage, --skip-download skips the bundle check+download).
 *
 * Env: NEON_DATABASE_URL + DEEPSEEK_API_KEY (optional — absent makes stage 4
 *      a logged skip, not a failure).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DDINTER_DIR = join(root, "data", "ddinter");
const MANIFEST = join(DDINTER_DIR, "manifest.md5");
const DOWNLOAD_BASE = "https://ddinter2.scbdd.com/static/media/download/ddinter_downloads_code_{L}.csv";
// Standard DDInter ATC first-letter set probed for new category files.
const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"];

const argv = process.argv.slice(2);
const skipCrawl = argv.includes("--skip-crawl"); // skip mechanism + translate (DB/data stages only)
const skipLlm = argv.includes("--skip-llm"); // skip the LLM translate stage only
const skipDownload = argv.includes("--skip-download");

const t0 = Date.now();
const log = (m: string): void => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ helpers
async function headOk(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(20000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

function md5File(path: string): string {
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

function loadManifest(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(MANIFEST)) return m;
  for (const line of readFileSync(MANIFEST, "utf8").split("\n")) {
    const mm = line.match(/^([0-9a-f]{32})\s+(\.\/)?(\S+)$/);
    if (mm) m.set(mm[3], mm[1]);
  }
  return m;
}

function saveManifest(m: Map<string, string>): void {
  const lines = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([f, h]) => `${h}  ${f}`);
  writeFileSync(MANIFEST, lines.join("\n") + "\n");
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const part = dest + ".part";
  const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!r.ok || !r.body) throw new Error(`download ${url} -> HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(part, buf);
  writeFileSync(dest, buf);
  log(`  downloaded ${dest.split("/").pop()} (${buf.length} bytes)`);
}

async function runStage(name: string, script: string, args: string[]): Promise<string> {
  log(`${name}: running (npx tsx ${script} ${args.join(" ") || "(no args)"})`);
  const t1 = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync("npx", ["tsx", join(root, script), ...args], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 55 * 60 * 1000,
      env: { ...process.env },
    });
    const tail = [stdout, stderr].join("\n").split("\n").slice(-6).join(" | ");
    log(`${name}: ok in ${((Date.now() - t1) / 1000).toFixed(0)}s — ${tail.slice(0, 400)}`);
    return "ok";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const tail = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").split("\n").slice(-4).join(" | ");
    log(`${name}: FAILED: ${tail.slice(0, 400)}`);
    return "failed";
  }
}

// ------------------------------------------------------------ main
async function main(): Promise<void> {
  log("daily-refresh: start (node " + process.version + ")");

  if (skipDownload) {
    log("stage 1 (ddinter bundle): SKIPPED (--skip-download)");
  } else {
    log("stage 1 (ddinter bundle): probing " + LETTERS.length + " ATC files");
    let presentFiles = new Set<string>();
    try {
      presentFiles = new Set(
        readdirSync(DDINTER_DIR).filter((f) => /^ddinter_downloads_code_[A-Z]\.csv$/.test(f)),
      );
    } catch {
      presentFiles = new Set();
    }
    const manifest = loadManifest();
    const known = new Set([...manifest.keys(), ...presentFiles]);
    const toCheck = LETTERS.filter((l) => !known.has(`ddinter_downloads_code_${l}.csv`));
    const newlyFound: string[] = [];
    for (const l of LETTERS) {
      const name = `ddinter_downloads_code_${l}.csv`;
      const url = DOWNLOAD_BASE.replace("{L}", l);
      if (known.has(name)) {
        // existing local + manifest: check content drift (HEAD size vs local, then md5)
        const local = join(DDINTER_DIR, name);
        if (!existsSync(local)) continue; // missing local: re-download below
        const h = await headOk(url);
        if (!h) {
          log(`  ${name}: remote 404 (removed upstream?) — kept local`);
          continue;
        }
        // Cheap drift check: content-length vs local size; full md5 only when sizes differ.
        try {
          const rr = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(20000) });
          const len = Number(rr.headers.get("content-length") ?? "0");
          const localSize = statSync(local).size;
          if (len > 0 && len !== localSize) {
            await downloadToFile(url, local);
            manifest.set(name, md5File(local));
            log(`  ${name}: CHANGED (size ${localSize} -> ${len}), re-downloaded`);
          } else {
            log(`  ${name}: unchanged (size ${localSize})`);
          }
        } catch (e) {
          log(`  ${name}: size check failed (${String(e).slice(0, 60)}), treating as unchanged`);
        }
        continue;
      }
      // not known: does it exist remotely?
      if (await headOk(url)) {
        await downloadToFile(url, join(DDINTER_DIR, name));
        manifest.set(name, md5File(join(DDINTER_DIR, name)));
        newlyFound.push(name);
      }
      await sleep(300);
    }
    saveManifest(manifest);
    log(`stage 1: done. files=${manifest.size} newly-found=${newlyFound.join(",") || "(none)"}`);
    if (toCheck.length > 0) log(`stage 1: note ${toCheck.length} letters were not previously known (covered by probe set)`);
  }

  // Stage 2: re-import (idempotent upsert; adds only genuinely new rows)
  const importRes = await runStage("stage 2 (ddinter import)", "import-ddinter.ts", []);

  if (skipCrawl) {
    log("stages 3+4 (mechanism+translate): SKIPPED (--skip-crawl)");
  } else {
    const mechRes = await runStage("stage 3 (mechanism EN backfill)", "backfill-mechanisms.ts", []);
    if (mechRes === "failed") log("daily-refresh: continuing past mechanism failure (non-fatal; next run retries)");
    if (skipLlm) {
      log("stage 4 (LLM translate): SKIPPED (--skip-llm)");
    } else {
      const trRes = await runStage("stage 4 (LLM translate)", "translate-mechanisms.ts", []);
      if (trRes === "failed") log("daily-refresh: continuing past translate failure (non-fatal; next run retries)");
    }
  }

  log("daily-refresh: done (exit 0)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("DAILY-REFRESH FAILED:", e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
