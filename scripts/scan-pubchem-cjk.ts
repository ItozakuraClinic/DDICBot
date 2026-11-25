// Scan: for every distinct DDInter drug name, does PubChem carry >=1 CJK synonym?
// Uses PubChem bulk endpoints (name->CID in batches of 100, synonyms in <=5k CID batches).
// Writes data/pubchem/scan-cjk.json with per-drug CJK counts and a summary.
// Rate limit: 5 req/s max per PubChem policy — small sleeps between requests.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "..", "data");
const outDir = path.join(here, "..", "data", "pubchem");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let names = new Set<string>();
if (process.argv[2]) {
  names = new Set(JSON.parse(readFileSync(process.argv[2], "utf8")));
} else {
  const dir = path.join(dataDir, "ddinter");
  const files = readdirSync(dir)
    .filter((f) => /^ddinter_downloads_code_[A-ZVU]\.csv$/.test(f))
    .map((f) => path.join(dir, f));
  files.sort();
  for (const f of files) {
    let csv = readFileSync(f, "utf8");
    for (const line of csv.split("\n").slice(1)) {
      if (!line.trim()) continue;
      // minimal CSV quote-aware parse of 5 cols
      const cols = parseCsvLine(line);
      if (cols.length >= 4) {
        names.add(cols[1].trim());
        names.add(cols[3].trim());
      }
    }
  }
}
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

const nameArr = [...names];

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

async function main(): Promise<void> {
console.log("distinct DDInter drug names:", nameArr.length);

const BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const UA = "DDICBot/0.1 (research; contact artefaritaKuniklo@users.noreply.github.com)";

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20000),
        ...init,
      });
      if (res.status === 429 || res.status >= 500) {
        const wait = 1000 * 2 ** attempt;
        console.error(`  ${res.status} on ${url.slice(0, 90)} — retry in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
      return await res.json();
    } catch (e) {
      if (attempt === 5) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error("unreachable");
}

// 1) name -> CID, one request per name (order-safe; logs misses + ambiguities)
const cidOf: Record<string, number | null> = {};
const unresolved: string[] = [];
const ambiguous: Record<string, number[]> = {};
for (let i = 0; i < nameArr.length; i++) {
  const name = nameArr[i];
  const enc = encodeURIComponent(name);
  try {
    const r = (await fetchJson(`${BASE}/compound/name/${enc}/cids/JSON`)) as {
      IdentifierList?: { CID?: number[] };
    };
    const cids = r.IdentifierList?.CID ?? [];
    if (cids.length >= 1) {
      cidOf[name] = cids[0];
      if (cids.length > 2) ambiguous[name] = cids;
    } else unresolved.push(name);
  } catch {
    unresolved.push(name);
  }
  await sleep(200);
  if ((i + 1) % 250 === 0) console.log(`  resolved names: ${i + 1}/${nameArr.length}`);
}
console.log("resolved to CID:", Object.keys(cidOf).length, "unresolved:", unresolved.length, "ambiguous(>2):", Object.keys(ambiguous).length);

// 2) bulk synonyms (5000 CIDs per request)
const hasCid = Object.values(cidOf) as number[];
const cjkOf: Record<number, string[]> = {};
let compoundsWithCjk = 0;
let totalCjkSynonyms = 0;
for (let i = 0; i < hasCid.length; i += 5000) {
  const batch = hasCid.slice(i, i + 5000);
  const r = (await fetchJson(
    `${BASE}/compound/cid/${batch.join(",")}/synonyms/JSON?string_length=3000`,
  )) as { InformationList?: { Information?: { CID: number; Synonym: string[] }[] } };
  for (const info of r.InformationList?.Information ?? []) {
    const cjk = (info.Synonym ?? []).filter((s) => /[\u4e00-\u9fff\u3040-\u30ff]/.test(s));
    if (cjk.length > 0) {
      cjkOf[info.CID] = cjk;
      compoundsWithCjk++;
      totalCjkSynonyms += cjk.length;
    }
  }
  console.log(`  synonyms batch through CID index ${Math.min(i + 5000, hasCid.length)}/${hasCid.length}`);
  await sleep(250);
}

const withCjk: Record<string, string[]> = {};
for (const [name, cid] of Object.entries(cidOf)) {
  const c = cjkOf[cid as number];
  if (c) withCjk[name] = c;
}
const summary = {
  scanned: nameArr.length,
  resolved: Object.keys(cidOf).length,
  unresolved,
  ambiguousCount: Object.keys(ambiguous).length,
  compoundsWithCjk,
  totalCjkSynonyms,
  sample: Object.fromEntries(
    Object.entries(withCjk).slice(0, 10).map(([k, v]) => [k, v.slice(0, 5)]),
  ),
  cjkByName: withCjk,
};
const outFile = path.join(outDir, "scan-cjk.json");
writeFileSync(outFile, JSON.stringify(summary, null, 1));
console.log("WROTE", outFile);
console.log(
  "RESULT: compounds with >=1 CJK synonym =",
  compoundsWithCjk,
  "of",
  summary.resolved,
  `(${((compoundsWithCjk / Math.max(1, summary.resolved)) * 100).toFixed(1)}%)`,
  "| total CJK synonym strings:",
  totalCjkSynonyms,
);
}
