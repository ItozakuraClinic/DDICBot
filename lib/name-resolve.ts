import type { PoolClient } from "pg";
import { getPool } from "./db";

/**
 * Name resolution: raw surface name + lang hint → ingredient_id.
 *
 * Two deterministic steps (P1T5):
 *   1. Exact match on drug_names.surface_name — case-INsensitive for en
 *      (collation-insensitive text comparison), exact for zh/ja.
 *   2. pg_trgm fuzzy fallback: `WHERE lang=$2 AND surface_name % $1`,
 *      top 5 candidates, threshold similarity >= 0.3 (task-pinned).
 *
 * LLM expansion is deliberately OUT of scope here (guarded later phase);
 * resolution is fully deterministic and testable against the live DB.
 */

export type Lang = "en" | "zh" | "ja";

/** The trgm fuzzy-search threshold pinned by the P1T5 contract. */
export const FUZZY_THRESHOLD = 0.3;

export interface NameCandidate {
  ingredient_id: string;
  surface_name: string;
  sim: number;
}

export interface NameResolution {
  /** Set only on a confident hit (exact, or a unique unambiguous fuzzy match). */
  ingredient_id?: string;
  /** How the hit was made; "none" when nothing confident surfaced. */
  confidence: "exact" | "fuzzy" | "none";
  /** Top-5 fuzzy candidates (always populated when the fuzzy step ran). */
  candidates: NameCandidate[];
  /** The surface name the hit came from (for echo/display). */
  matched_surface_name?: string;
  /** The language scope that produced the hit, if any. */
  matched_lang?: Lang;
}

/**
 * Input normalization: trim, full-width → half-width (digits, latin, common
 * punctuation — users on Chinese keyboards often type ａｓｐｉｒｉｎ),
 * collapse internal whitespace. Never lowercases (lang decides match mode).
 */
export function normalize(s: string): string {
  return s
    .trim()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ");
}

/** Exact-match SQL per language: en compares case-insensitively, zh/ja exactly. */
function exactPredicate(lang: Lang): string {
  return lang === "en" ? "lower(surface_name) = lower($1)" : "surface_name = $1";
}

async function exactMatch(client: PoolClient, raw: string, lang: Lang) {
  const q = `
    SELECT d.ingredient_id, d.surface_name, d.source
    FROM drug_names d
    WHERE d.lang = $2 AND ${exactPredicate(lang)}
    ORDER BY CASE WHEN d.source = 'DDInter' THEN 0 WHEN d.source LIKE '%xNorm%' THEN 1
                  WHEN d.source = 'wikidata' THEN 2 ELSE 3 END,
             d.surface_name
    LIMIT 25`;
  const rows = await client.query(q, [raw, lang]);
  const ids = new Set<string>();
  for (const r of rows.rows) ids.add(r.ingredient_id);
  return { rows: rows.rows, distinctIds: [...ids] };
}

async function fuzzyMatch(client: PoolClient, raw: string, lang: Lang) {
  // Threshold is contract-pinned at 0.3 (P1S5). Similarity is computed on
  // lower(): pg_trgm is case-SENSITIVE, and users type "simvastine" against
  // a "Simvastatin" row — the GIN trgm index can't see across case, but the
  // table is 5.5k rows in P1, so a per-row similarity() scan (few ms) is the
  // honest trade for case-insensitive recall. No % operator: it would only
  // match the exact-case form.
  const rows = await client.query(
    `
    SELECT ingredient_id, surface_name, similarity(lower(surface_name), lower($1)) AS sim
    FROM drug_names
    WHERE lang = $2
      AND similarity(lower(surface_name), lower($1)) >= $3
    ORDER BY sim DESC, surface_name
    LIMIT 20`,
    [raw, lang, FUZZY_THRESHOLD],
  );
  // Dedupe by ingredient: many surface forms of one drug come back
  // (aspirin/Aspirin/ASPIRIN) and must not read as "multiple candidates".
  const byId = new Map<string, NameCandidate>();
  for (const r of rows.rows as { ingredient_id: string; surface_name: string; sim: string }[]) {
    const sim = Number(r.sim);
    const prev = byId.get(r.ingredient_id);
    if (!prev || sim > prev.sim) {
      byId.set(r.ingredient_id, {
        ingredient_id: r.ingredient_id,
        surface_name: prev ? prev.surface_name : r.surface_name,
        sim: prev ? Math.max(prev.sim, sim) : sim,
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.sim - a.sim).slice(0, 5);
}

/**
 * Resolve one surface name within one language scope.
 *
 * Exact-hit ambiguity policy: some surface forms are legitimately shared
 * across ingredients (e.g. "penicillin g" → 3 ingredients, "insulin,
 * regular, human" → 6). A shared name is NOT a confident hit — the caller
 * must not silently pick one (safety-critical: wrong-drug results must not
 * render as definite). Such names surface their fuzzy candidates instead.
 */
export async function resolveNameInLang(raw: string, lang: Lang): Promise<NameResolution> {
  const client = await getPool().connect();
  try {
    const q = normalize(raw);
    if (!q) {
      return { confidence: "none", candidates: [] };
    }

    const exact = await exactMatch(client, q, lang);
    if (exact.rows.length > 0) {
      if (exact.distinctIds.length === 1) {
        return {
          ingredient_id: exact.distinctIds[0],
          confidence: "exact",
          candidates: [],
          matched_surface_name: exact.rows[0].surface_name,
          matched_lang: lang,
        };
      }
      // Shared surface form: not confident. Fall through to fuzzy so the
      // caller gets candidates instead of a silently-wrong single id.
    }

    const candidates = await fuzzyMatch(client, q, lang);
    if (candidates.length === 1 && candidates[0].sim >= FUZZY_THRESHOLD) {
      return {
        ingredient_id: candidates[0].ingredient_id,
        confidence: "fuzzy",
        candidates,
        matched_surface_name: candidates[0].surface_name,
        matched_lang: lang,
      };
    }
    return { confidence: "none", candidates };
  } finally {
    client.release();
  }
}

/**
 * Resolve with a language hint: try the hinted scope first, then the others
 * (en/zh/ja). Returns the first confident resolution, aggregating the best
 * candidates seen so far (for the unresolvable → "did you mean" prompt).
 */
export async function resolveDrugName(raw: string, hint: Lang): Promise<NameResolution> {
  const scopes: Lang[] = [hint, ...(["en", "zh", "ja"] as Lang[]).filter((l) => l !== hint)];
  let best: NameResolution = { confidence: "none", candidates: [] };
  for (const lang of scopes) {
    const r = await resolveNameInLang(raw, lang);
    if (r.confidence !== "none") return r;
    if (r.candidates.length > best.candidates.length) best = r;
  }
  return best;
}

/** Split a /check argument into drug tokens: space, ASCII comma, 、, , and
 *  newlines separate; surrounding whitespace and stray brackets are stripped. */
export function parseDrugTokens(arg: string): string[] {
  return arg
    .split(/[\s,、；;，\n\r\t]+/)
    .map((t) =>
      t.replace(/^["'“”‘’([[\(【（「]+|["'“”‘’\])\]】）」]+$/g, "").trim(),
    )
    .filter((t) => t.length > 0);
}
