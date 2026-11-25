/**
 * name-resolve unit tests (P1T5).
 *
 * Static tests run always: normalization, token parsing, the ambiguity /
 * confidence decision logic via resolveNameInLang's contract (asserted where
 * testable without DB). DB-backed tests are tagged and run only with
 * DDBOT_TEST_DB=1 (CI has no network; local runs hit the real Neon branch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FUZZY_THRESHOLD,
  normalize,
  parseDrugTokens,
  resolveDrugName,
  resolveNameInLang,
} from "../lib/name-resolve.ts";
import { SEVERITY_RANK } from "../lib/ddi-query.ts";

const HAS_DB = Boolean(process.env.NEON_DATABASE_URL);

test("FUZZY_THRESHOLD is the contract-pinned 0.3", () => {
  assert.equal(FUZZY_THRESHOLD, 0.3);
});

test("normalize: trim, collapse spaces, full-width → half-width", () => {
  assert.equal(normalize("  Aspirin "), "Aspirin");
  assert.equal(normalize("a\u3000 b  c"), "a b c");
  assert.equal(normalize("\uff41\uff53\uff50\uff49\uff52\uff49\uff4e"), "aspirin");
  assert.equal(normalize("A S P I R I N"), "A S P I R I N"); // spaces kept, only collapsed
  assert.equal(normalize(""), "");
});

test("parseDrugTokens: space, ASCII comma, CJK separators, quotes/brackets", () => {
  assert.deepStrictEqual(parseDrugTokens("simvastatin aspirin"), ["simvastatin", "aspirin"]);
  assert.deepStrictEqual(parseDrugTokens("simvastatin, aspirin"), ["simvastatin", "aspirin"]);
  assert.deepStrictEqual(parseDrugTokens("simvastatin、aspirin"), ["simvastatin", "aspirin"]);
  assert.deepStrictEqual(parseDrugTokens('"warfarin", "aspirin"'), ["warfarin", "aspirin"]);
  assert.deepStrictEqual(parseDrugTokens("（阿司匹林）,布洛芬"), ["阿司匹林", "布洛芬"]);
  assert.deepStrictEqual(parseDrugTokens("   "), []);
  assert.deepStrictEqual(parseDrugTokens("one"), ["one"]);
});

test("SEVERITY_RANK order: Major < Moderate < Minor < Unknown", () => {
  assert.ok(SEVERITY_RANK.Major < SEVERITY_RANK.Moderate);
  assert.ok(SEVERITY_RANK.Moderate < SEVERITY_RANK.Minor);
  assert.ok(SEVERITY_RANK.Minor < SEVERITY_RANK.Unknown);
});

// ── DB-backed tests (Neon branch database) ───────────────────────────────

(async () => {
  if (!HAS_DB) {
    test.skip("db-backed tests skipped (set NEON_DATABASE_URL)", () => {});
    return;
  }

  test("exact: '阿司匹林' (zh) → aspirin ingredient (case-exact zh)", async () => {
    const r = await resolveNameInLang("阿司匹林", "zh");
    assert.equal(r.confidence, "exact");
    assert.equal(r.ingredient_id, "DDInter20");
    assert.equal(r.matched_surface_name, "阿司匹林");
  });

  test("exact: '阿司匹林' via lang hint en (cross-language fallback)", async () => {
    // hint en: no zh string in en scope → falls through to zh scope, exact hit
    const r = await resolveDrugName("阿司匹林", "en");
    assert.equal(r.confidence, "exact");
    assert.equal(r.ingredient_id, "DDInter20");
  });

  test("exact: 'Aspirin' (en, case-insensitive) → same ingredient as 阿司匹林", async () => {
    const r = await resolveNameInLang("Aspirin", "en");
    assert.equal(r.confidence, "exact");
    assert.equal(r.ingredient_id, "DDInter20");
    const rLower = await resolveNameInLang("aspirin", "en");
    assert.equal(rLower.confidence, "exact");
    assert.equal(rLower.ingredient_id, "DDInter20");
    const rUpper = await resolveNameInLang("ASPIRIN", "en");
    assert.equal(rUpper.confidence, "exact");
    assert.equal(rUpper.ingredient_id, "DDInter20");
  });

  test("fuzzy: 'aspirn' (typo) → fuzzy confidence, aspirin top candidate", async () => {
    const r = await resolveNameInLang("aspirn", "en");
    // 'aspirn' is not an exact surface; expect a confident fuzzy resolution
    // to DDInter20 (sim ≈ 0.5 ≥ 0.3) — or, if a literal 'aspirn' surface row
    // exists, an exact hit to the same ingredient. Either is correct.
    assert.ok(r.confidence === "fuzzy" || r.confidence === "exact");
    assert.equal(r.ingredient_id, "DDInter20");
    if (r.confidence === "fuzzy") {
      assert.ok(r.candidates.length >= 1);
      assert.ok(r.candidates[0].sim >= FUZZY_THRESHOLD);
    }
  });

  test("fuzzy: 'simvastine' (typo) → surfaces simvastatin as top candidate (ambiguity gate)", async () => {
    // 'simvastine' scores ~0.53 for Simvastatin (DDInter1675) but ~0.35 for
    // Acrivastine (DDInter23) — two distinct ingredients cross the 0.3
    // threshold. The resolver must NOT auto-pick between two real drugs
    // (safety-critical: wrong-drug DDI results are worse than a re-prompt):
    // confidence stays 'none' and both candidates are surfaced for the
    // user to re-type precisely.
    const r = await resolveNameInLang("simvastine", "en");
    assert.equal(r.confidence, "none");
    assert.equal(r.ingredient_id, undefined);
    assert.ok(r.candidates.length >= 2);
    assert.equal(r.candidates[0].ingredient_id, "DDInter1675");
    assert.ok(r.candidates[0].sim >= FUZZY_THRESHOLD);
  });

  test("fuzzy: unique-candidate auto-resolve (single ingredient above threshold)", async () => {
    // 'fluconozole' → Fluconazole (DDInter743, sim ~0.6) is the ONLY
    // ingredient across the 0.3 threshold, so the resolver auto-resolves
    // with confidence 'fuzzy'.
    const r = await resolveNameInLang("fluconozole", "en");
    assert.equal(r.confidence, "fuzzy");
    assert.equal(r.ingredient_id, "DDInter743");
    assert.equal(r.candidates[0].ingredient_id, "DDInter743");
    assert.ok(r.candidates[0].sim >= FUZZY_THRESHOLD);
  });

  test("fuzzy ambiguity gate: omeprazol surfaces two real drugs, no auto-pick", async () => {
    // 'omeprazol' scores 0.75 (Omeprazole) and 0.44 (Esomeprazole) — two
    // distinct drugs, so the resolver must refuse to auto-resolve and give
    // the caller the candidate list instead (wrong-drug DDI results are the
    // failure mode this exists to prevent).
    const r = await resolveNameInLang("omeprazol", "en");
    assert.equal(r.confidence, "none");
    assert.ok(r.candidates.length >= 2);
    const ids = r.candidates.map((c) => c.ingredient_id);
    assert.ok(ids.includes("DDInter1340") && ids.includes("DDInter676"));
  });

  test("unresolvable: nonsense strings → confidence none, no ingredient_id", async () => {
    for (const s of ["zzzzqqqq notadrg", "xkcdflurb 92741"]) {
      for (const lang of ["en", "zh"] as const) {
        const r = await resolveNameInLang(s, lang);
        assert.equal(r.confidence, "none", `${s} @ ${lang}`);
        assert.equal(r.ingredient_id, undefined, `${s} @ ${lang}`);
      }
    }
  });

  test("empty input → confidence none", async () => {
    const r = await resolveNameInLang("   ", "en");
    assert.equal(r.confidence, "none");
  });

  test("full-width input 'ａｓｐｉｒｉｎ' → aspirin after normalize()", async () => {
    const r = await resolveNameInLang("\uff41\uff53\uff50\uff49\uff52\uff49\uff4e", "en");
    assert.equal(r.ingredient_id, "DDInter20");
  });
})();
