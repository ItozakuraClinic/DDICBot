// Decisive probe: (1) RxNorm release reachability, (2) Wikidata zh-label
// coverage for a sample of DDInter drug names. Prints only summary numbers.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const UA = "DDICBot/0.1 (research)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RXNORM_URL = "https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_current.zip";

async function rxnormReachable(): Promise<string> {
  try {
    const res = await fetch(RXNORM_URL, {
      method: "HEAD",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(20000),
    });
    const len = res.headers.get("content-length");
    return `HTTP ${res.status} content-length=${len ?? "?"}`;
  } catch (e) {
    return `UNREACHABLE: ${String(e).slice(0, 80)}`;
  }
}

async function wikidataZhLabel(name: string): Promise<string | null> {
  // Fast path: search API for the term, take top drug item, read zh label.
  const api =
    "https://www.wikidata.org/w/api.php?action=query&format=json" +
    "&generator=search&gsrnamespace=0&gsrlimit=1&gsrsearch=" +
    encodeURIComponent(name) +
    "&prop=labels&languagecodes=en%7Czh&llangconvert=yes";
  try {
    const res = await fetch(api, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const pages = d?.query?.pages ?? {};
    const p = Object.values(pages)[0] as any;
    const zh = p?.labels?.zh?.value;
    return zh ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log("RxNorm:", await rxnormReachable());

  // Read distinct DDInter drug names (first ~12 as a coverage sample)
  const dir = path.join(here, "..", "data", "ddinter");
  const names = new Set<string>();
  const { readdirSync } = await import("node:fs");
  for (const f of readdirSync(dir).filter((f) => f.startsWith("ddinter_downloads_"))) {
    const lines = readFileSync(path.join(dir, f), "utf8").split("\n").slice(1);
    for (const line of lines.slice(0, 4000)) {
      const cols = line.split(",");
      if (cols.length >= 4 && cols[1]) names.add(cols[1].trim());
      if (names.size >= 4000) break;
    }
    if (names.size >= 4000) break;
  }
  const sample = [...names].slice(0, 12);
  const zhHits: [string, string][] = [];
  for (const n of sample) {
    const zh = await wikidataZhLabel(n);
    if (zh) zhHits.push([n, zh]);
    await sleep(500);
  }
  console.log(`Wikidata zh-label on sample of ${sample.length} names: ${zhHits.length} hits`);
  for (const [n, zh] of zhHits) console.log(`   ${n} -> ${zh}`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
