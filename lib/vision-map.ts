/**
 * Map LLM-extracted names → DB-validated candidates (P2T1).
 *
 * The vision model is a candidate-EXPANSION layer only: its output may be
 * hallucinated, misspelled, or fabricated. Every name it returns is resolved
 * through the existing name-resolve module (exact + pg_trgm against
 * drug_names). A candidate SURVIVES ONLY if the database confirms a real
 * ingredient; the user's button tap is the final arbiter (never-auto-match).
 *
 * Per-LLM-name survival rules (photo-flow semantics — this does NOT modify
 * the /check resolver, whose ambiguity gating must stay strict):
 *   1. Confident hit (exact, or unique fuzzy): the ingredient survives with
 *      full model confidence.
 *   2. Ambiguous fuzzy (multiple ingredients above the 0.3 threshold): the
 *      top-3 ingredients survive, each scaled by its similarity
 *      (score = confidence × sim) so the plausible reading outranks the
 *      near-miss ones. Showing them is safe: the confirmation keyboard is
 *      exactly where ambiguity is meant to be resolved — by a tap.
 *   3. Nothing above the threshold: dropped (e.g. 'asprion' → aspirin at
 *      0.23). The user re-taps or re-types via /check.
 */
import { FUZZY_THRESHOLD, resolveDrugName, type Lang } from "./name-resolve";
import { VISION_MAX_CANDIDATES, type VisionCandidate } from "./vision";

export interface MappedCandidate {
  /** DB-canonical ingredient_id (survived resolution). */
  ingredient_id: string;
  /** DB surface name for display (never the raw LLM string as the identity). */
  db_name: string;
  /** The name the model reported (echoed for user context only). */
  llm_name: string;
  /** "exact" | "fuzzy" (name-resolve confidence classes; ambiguous fuzzy
   *  rescues are always "fuzzy"). */
  how: "exact" | "fuzzy";
  /** Effective display score in [0,1]: model confidence (× similarity for
   *  ambiguous rescues). This is the % shown on the candidate button. */
  confidence: number;
}

/** Ambiguous rescues show at most this many ingredients per LLM name. */
const AMBIGUOUS_TOP_K = 3;

/**
 * Resolve each LLM candidate against drug_names.
 *
 * Dedupe across names by ingredient (aspirin + Aspirin + "aspirin 100mg" →
 * one row); the highest effective score wins. Sorted by effective score
 * desc, capped at 5 (task-pinned).
 */
export async function mapVisionToDb(
  raw: VisionCandidate[],
  langHint: Lang = "zh",
): Promise<MappedCandidate[]> {
  if (raw.length === 0) return [];
  const settled = await Promise.all(
    raw.map(async (c) => ({ c, r: await resolveDrugName(c.name, langHint) })),
  );

  const emitted: MappedCandidate[] = [];
  for (const { c, r } of settled) {
    if (r.ingredient_id) {
      emitted.push({
        ingredient_id: r.ingredient_id,
        db_name: r.matched_surface_name ?? c.name,
        llm_name: c.name,
        how: r.confidence === "exact" ? "exact" : "fuzzy",
        confidence: c.confidence,
      });
      continue;
    }
    // No confident hit (ambiguous or no candidate): promote the resolver's
    // top-k candidates — each is a real DB ingredient above the 0.3
    // similarity threshold. The confirmation keyboard (a tap) is exactly
    // where this ambiguity is meant to be resolved.
    for (const cand of r.candidates.slice(0, AMBIGUOUS_TOP_K)) {
      if (cand.sim < FUZZY_THRESHOLD) continue;
      emitted.push({
        ingredient_id: cand.ingredient_id,
        db_name: cand.surface_name,
        llm_name: c.name,
        how: "fuzzy",
        confidence: c.confidence * cand.sim,
      });
    }
  }

  const byId = new Map<string, MappedCandidate>();
  for (const e of emitted) {
    const prev = byId.get(e.ingredient_id);
    if (!prev || e.confidence > prev.confidence) byId.set(e.ingredient_id, e);
  }
  return [...byId.values()].sort((a, b) => b.confidence - a.confidence).slice(0, VISION_MAX_CANDIDATES);
}
