import { getPool } from "./db";

/**
 * DDI query core (P1T6): two ingredient_ids → the pair row, both directions.
 *
 * ddi_pairs stores each unordered pair once with drug_a < drug_b, so the
 * lookup checks both directions (indexed by idx_ddi_pairs_ab / _ba).
 *
 * SAFETY CONTRACT (non-negotiable, project rule 2): `found: false` means
 * "the database has no row for this combination". Callers MUST render
 * "数据库未收录该组合" (not in the database) — NEVER "no interaction",
 * "safe", or any wording that implies the combination is fine.
 */

export type Severity = "Major" | "Moderate" | "Minor" | "Unknown";

export const SEVERITY_RANK: Record<Severity, number> = {
  Major: 0,
  Moderate: 1,
  Minor: 2,
  Unknown: 3,
};

export interface DdiResult {
  found: boolean;
  /** Undefined when not found. "Unknown" is a real DDInter severity value. */
  severity?: Severity;
  /** English source mechanism text; NULL for pairs outside the Phase-3
   *  UI-crawl coverage (8,463 of 236,834 pairs have it after the backfill). */
  mechanism_en?: string | null;
  /** LLM-translated mechanism (P3T2); null until scripts/translate-mechanisms.ts
   *  has covered the pair. Translation layer only — never alters the EN text. */
  mechanism_zh?: string | null;
  mechanism_ja?: string | null;
  /** How many ddi_pairs rows matched (1 in practice; unique pair invariant). */
  pair_count: number;
}

const PAIR_SQL = `
  SELECT severity, mechanism_en, mechanism_zh, mechanism_ja,
         COUNT(*) OVER () AS pair_count
  FROM ddi_pairs
  WHERE (drug_a_ingredient = $1 AND drug_b_ingredient = $2)
     OR (drug_a_ingredient = $2 AND drug_b_ingredient = $1)
  LIMIT 2`;

export async function queryDdi(
  idA: string,
  idB: string,
): Promise<DdiResult> {
  if (idA === idB) {
    return { found: false, pair_count: 0 };
  }
  const client = await getPool().connect();
  try {
    const rows = await client.query(PAIR_SQL, [idA, idB]);
    if (rows.rowCount === 0) {
      return { found: false, pair_count: 0 };
    }
    const row = rows.rows[0] as {
      severity: string;
      mechanism_en: string | null;
      mechanism_zh: string | null;
      mechanism_ja: string | null;
      pair_count: string | number;
    };
    const severity = row.severity as Severity;
    return {
      found: true,
      severity,
      mechanism_en: row.mechanism_en,
      mechanism_zh: row.mechanism_zh,
      mechanism_ja: row.mechanism_ja,
      pair_count: Number(row.pair_count),
    };
  } finally {
    client.release();
  }
}

/**
 * Fetch display names (for the rendered pair header) across all languages.
 * Returns one entry per language found; callers prefer the user's lang and
 * fall back to en.
 */
export async function fetchDisplayNames(ingredientIds: string[]): Promise<
  Record<string, { en: string[]; zh: string[]; ja: string[] }>
> {
  const out: Record<string, { en: string[]; zh: string[]; ja: string[] }> = {};
  const ids = [...new Set(ingredientIds)];
  if (ids.length === 0) return out;
  const client = await getPool().connect();
  try {
    const rows = await client.query(
      `SELECT ingredient_id, lang, surface_name
       FROM drug_names
       WHERE ingredient_id = ANY($1)
       ORDER BY ingredient_id, lang,
                CASE
                  WHEN (lang='en' AND source='DDInter') OR (lang='zh' AND source='wikidata') THEN 0
                  ELSE 1
                END,
                surface_name
       LIMIT 200`,
      [ids],
    );
    for (const r of rows.rows as { ingredient_id: string; lang: string; surface_name: string }[]) {
      const e = (out[r.ingredient_id] ??= { en: [], zh: [], ja: [] });
      if (r.lang === "en" || r.lang === "zh" || r.lang === "ja") {
        e[r.lang].push(r.surface_name);
      }
    }
    return out;
  } finally {
    client.release();
  }
}
