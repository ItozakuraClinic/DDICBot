/**
 * ddi-query unit tests (P1T6): found semantics, bidirectional lookup,
 * not-found wording contract, severity rank.
 *
 * DB-backed tests run with NEON_DATABASE_URL set (tagged, skipped otherwise).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { queryDdi, fetchDisplayNames, SEVERITY_RANK, type DdiResult } from "../lib/ddi-query.ts";
import { renderCheck, EMERGENCY_LINE, DISCLAIMER_LINE, NOT_IN_DB_ZH } from "../lib/render.ts";
import type { NameResolution } from "../lib/name-resolve.ts";

const HAS_DB = Boolean(process.env.NEON_DATABASE_URL);

// ── Not-found wording contract (no DB needed) ────────────────────────────

function emptyResolution(): NameResolution {
  return { confidence: "none", candidates: [] };
}
function exactResolution(id: string): NameResolution {
  return {
    ingredient_id: id,
    confidence: "exact",
    candidates: [],
    matched_surface_name: id,
    matched_lang: "en",
  };
}

test("not-found result: renderer emits 未收录 wording, never 'no interaction'/'safe'", () => {
  const ddi: DdiResult = { found: false, pair_count: 0 };
  const r = renderCheck(
    { raw: "aaa", resolution: exactResolution("DDInter1") },
    { raw: "bbb", resolution: exactResolution("DDInter2") },
    ddi,
    "zh",
    {},
  );
  assert.ok(String(r.text).includes(NOT_IN_DB_ZH));
  assert.ok(!/no interaction/i.test(r.text), "must not claim 'no interaction'");
  assert.ok(!/\bsafe\b/i.test(r.text), "must not imply 'safe'");
  assert.ok(String(r.text).includes(EMERGENCY_LINE));
  assert.ok(String(r.text).includes(DISCLAIMER_LINE));
});

test("unresolvable result: still carries 未收录 line + mandatory footer", () => {
  const r = renderCheck(
    { raw: "zzzzqqqq", resolution: emptyResolution() },
    { raw: "aaaa", resolution: emptyResolution() },
    { found: false, pair_count: 0 },
    "zh",
    {},
  );
  assert.ok(String(r.text).includes("无法识别"));
  assert.ok(String(r.text).includes("zzzzqqqq"));
  assert.ok(String(r.text).includes(NOT_IN_DB_ZH));
  assert.ok(String(r.text).includes(EMERGENCY_LINE));
  assert.ok(String(r.text).includes(DISCLAIMER_LINE));
  assert.ok(!/\bsafe\b/i.test(r.text));
});

test("found result: badge, mechanism-or-placeholder, footer (zh)", () => {
  const ddi: DdiResult = {
    found: true,
    severity: "Major",
    mechanism_en: null,
    pair_count: 1,
  };
  const r = renderCheck(
    { raw: "warfarin", resolution: exactResolution("DDInter1951") },
    { raw: "aspirin", resolution: exactResolution("DDInter20") },
    ddi,
    "zh",
    { DDInter1951: { en: ["Warfarin"], zh: ["华法林", "Warfarin"], ja: [] }, DDInter20: { en: ["Acetylsalicylic acid"], zh: ["阿司匹林"], ja: [] } },
  );
  assert.ok(String(r.text).includes("🔴 Major"));
  assert.ok(String(r.text).includes("warfarin"));
  assert.ok(String(r.text).includes(EMERGENCY_LINE));
  assert.ok(String(r.text).includes(DISCLAIMER_LINE));
  // mechanism_en is null → honest placeholder, not invented text
  assert.ok(/no mechanism text on record/i.test(r.text));
});

test("found result with mechanism text renders it (en lang)", () => {
  const ddi: DdiResult = {
    found: true,
    severity: "Moderate",
    mechanism_en: "Coagulation tests should be monitored closely (example text).",
    pair_count: 1,
  };
  const r = renderCheck(
    { raw: "a", resolution: exactResolution("X1") },
    { raw: "b", resolution: exactResolution("X2") },
    ddi,
    "en",
    {},
  );
  assert.ok(String(r.text).includes("🟡 Moderate"));
  assert.ok(String(r.text).includes("Mechanism: Coagulation tests should be monitored closely (example text)."));
  assert.ok(String(r.text).includes(EMERGENCY_LINE));
  assert.ok(String(r.text).includes(DISCLAIMER_LINE));
});

// ── DB-backed tests (Neon branch database) ───────────────────────────────

(async () => {
  if (!HAS_DB) {
    test.skip("db-backed tests skipped (set NEON_DATABASE_URL)", () => {});
    return;
  }

  test("queryDdi found: simvastatin (DDInter1675) + acetylsalicylic acid (DDInter20)", async () => {
    const r = await queryDdi("DDInter1675", "DDInter20");
    assert.equal(r.found, true);
    // Live DB truth (DDInter 2.0 bulk): this pair is labelled 'Unknown'.
    // Asserting the label the source actually carries — not an expected value.
    assert.equal(r.severity, "Unknown");
    assert.ok(r.pair_count >= 1);
    // mechanism_en is NULL across the bulk until the Phase-3 UI-crawl decision
    assert.equal(r.mechanism_en, null);
  });

  test("queryDdi bidirectional: reversed ids return the same row", async () => {
    const a = await queryDdi("DDInter1675", "DDInter20");
    const b = await queryDdi("DDInter20", "DDInter1675");
    assert.equal(a.found, b.found);
    assert.equal(a.severity, b.severity);
  });

  test("queryDdi Major path: warfarin (DDInter1951) + aspirin (DDInter20)", async () => {
    const r = await queryDdi("DDInter1951", "DDInter20");
    assert.equal(r.found, true);
    assert.equal(r.severity, "Major");
    assert.equal(SEVERITY_RANK[r.severity as keyof typeof SEVERITY_RANK], 0);
  });

  test("queryDdi not-found: a real pair with no ddi_pairs row", async () => {
    // DDInter101 × DDInter1 was verified at authoring time to have no row.
    // Defensive: if the data ever changes, the contract (found=false shape)
    // is what matters; assert that shape whenever it comes back not-found.
    const r = await queryDdi("DDInter101", "DDInter1");
    if (r.found) {
      throw new Error(
        "test premise changed: DDInter101+DDInter1 now exists — pick a new absent pair",
      );
    }
    assert.equal(r.pair_count, 0);
    assert.equal(r.severity, undefined);
  });

  test("queryDdi same-id input → not found (no self interaction)", async () => {
    const r = await queryDdi("DDInter20", "DDInter20");
    assert.equal(r.found, false);
  });

  test("fetchDisplayNames returns en+zh for aspirin ingredient", async () => {
    const n = await fetchDisplayNames(["DDInter20"]);
    assert.ok(n["DDInter20"]);
    assert.ok(n["DDInter20"].en.length > 0);
    assert.ok(n["DDInter20"].zh.length > 0);
    assert.ok(n["DDInter20"].zh.includes("阿司匹林"));
  });
})();
