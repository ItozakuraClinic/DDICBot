/**
 * Vision layer tests (P2T1).
 *
 * Static lane (always): parseModelOutput tolerance (fences, prose, truncation,
 * malformed), size-cap enforcement, the 5-candidate cap, and the
 * not-configured error taxonomy.
 *
 * DB lane (needs NEON_DATABASE_URL): mapVisionToDb against the live branch —
 * a hallucinated name must be dropped; an OCR-garbled name must still land
 * on its real ingredient via the existing exact+trgm resolver.
 */
import { loadHermesEnv } from "../scripts/_load-env.ts";
process.env.NEON_DATABASE_URL = process.env.NEON_DATABASE_URL || loadHermesEnv().NEON_DATABASE_URL || "";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VISION_MAX_CANDIDATES,
  VISION_MAX_BYTES,
  VISION_SYSTEM_PROMPT,
  VisionNotConfiguredError,
  VisionParseError,
  extractCandidates,
  parseModelOutput,
} from "../lib/vision.ts";
import { mapVisionToDb } from "../lib/vision-map.ts";

const HAS_DB = Boolean(process.env.NEON_DATABASE_URL);

// ---------------------------------------------------------------------------
// Contract pins
// ---------------------------------------------------------------------------

test("contract: system prompt is the pinned P2T1 wording", () => {
  assert.ok(VISION_SYSTEM_PROMPT.includes("Extract drug names visible in this image"));
  assert.ok(VISION_SYSTEM_PROMPT.includes("Max 5 candidates"));
  assert.ok(VISION_SYSTEM_PROMPT.includes("If no drug visible, return []"));
});

test("contract: caps are pinned (4MB bytes, 5 candidates)", () => {
  assert.equal(VISION_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(VISION_MAX_CANDIDATES, 5);
});

// ---------------------------------------------------------------------------
// parseModelOutput
// ---------------------------------------------------------------------------

test("parse: clean JSON array", () => {
  const out = parseModelOutput(
    '[{"name":"Simvastatin","lang":"en","confidence":0.99},{"name":"阿司匹林","lang":"zh","confidence":0.9}]',
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Simvastatin");
  assert.equal(out[0].lang, "en");
  assert.ok(out[0].confidence > 0.98);
});

test("parse: empty array stays empty (the 'no drug' channel)", () => {
  assert.deepEqual(parseModelOutput("[]"), []);
  assert.deepEqual(parseModelOutput('  \n [] \n '), []);
});

test("parse: markdown code fence stripped", () => {
  const out = parseModelOutput('```json\n[{"name":"Aspirin","lang":"en","confidence":1}]\n```');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Aspirin");
});

test("parse: surrounding prose stripped, array extracted", () => {
  const out = parseModelOutput(
    'I found the following: [{"name":"Warfarin","lang":"en","confidence":0.7}] hope that helps',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Warfarin");
});

test("parse: confidence clamped to [0,1]; non-numeric → 0", () => {
  const out = parseModelOutput(
    '[{"name":"A","lang":"en","confidence":1.7},{"name":"B","lang":"en","confidence":"high"},{"name":"C"}]',
  );
  assert.equal(out[0].confidence, 1);
  assert.equal(out[1].confidence, 0);
  assert.equal(out[2].confidence, 0);
});

test("parse: lang normalization tolerates synonyms; unknown → other", () => {
  const out = parseModelOutput(
    '[{"name":"A","lang":"English"},{"name":"B","lang":"中文"},{"name":"C","lang":"jp"}]',
  );
  assert.equal(out[0].lang, "en");
  assert.equal(out[1].lang, "other"); // 中文 not a code — normalization is strict on codes
  assert.equal(out[2].lang, "other");
});

test("parse: more than 5 names → capped to 5", () => {
  const names = ["A", "B", "C", "D", "E", "F", "G"];
  const raw = JSON.stringify(names.map((n) => ({ name: n, lang: "en", confidence: 0.9 })));
  const out = parseModelOutput(raw);
  assert.equal(out.length, 5);
});

test("parse: malformed JSON throws VisionParseError (never a fabricated array)", () => {
  assert.throws(() => parseModelOutput("no json here at all"), VisionParseError);
  // Valid JSON but not an array:
  assert.throws(() => parseModelOutput('{"candidates": []}'), VisionParseError);
});

test("parse: non-string names dropped (all unusable → [], never a fabricated candidate)", () => {
  assert.deepEqual(parseModelOutput(JSON.stringify([{ name: 42 }, { lang: "en" }])), []);
});

test("parse: elements without a name are dropped", () => {
  const out = parseModelOutput('[{"lang":"en"},{"name":"Aspirin","lang":"en","confidence":0.8},{}]');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Aspirin");
});

// ---------------------------------------------------------------------------
// extractCandidates input guards (no network needed: it throws before fetch)
// ---------------------------------------------------------------------------

test("extract: empty bytes rejected", async () => {
  await assert.rejects(extractCandidates(new Uint8Array(0), "image/jpeg"), VisionParseError);
});

test("extract: over-cap bytes rejected (no upstream call)", async () => {
  const big = new Uint8Array(VISION_MAX_BYTES + 1);
  await assert.rejects(extractCandidates(big, "image/jpeg"), /too large/);
});

test("extract: missing vision key → VisionNotConfiguredError (503 path)", async () => {
  delete process.env.DDICBOT_VISION_API_KEY;
  await assert.rejects(
    extractCandidates(new Uint8Array([1, 2, 3]), "image/jpeg"),
    VisionNotConfiguredError,
  );
});

// ---------------------------------------------------------------------------
// DB lane: the LLM is only candidate expansion; the DB is the source of truth
// ---------------------------------------------------------------------------

if (HAS_DB) {
  test("mapVisionToDb (live DB): hallucinated name dropped, real name confirmed", async () => {
    const out = await mapVisionToDb([
      { name: "Simvastatin", lang: "en", confidence: 0.99 },
      { name: "TotallyMadeUpDrug93847", lang: "en", confidence: 0.95 },
    ]);
    const names = out.map((c) => c.db_name.toLowerCase());
    assert.ok(names.length >= 1, "real name must survive");
    assert.ok(
      !out.some((c) => c.llm_name === "TotallyMadeUpDrug93847"),
      "hallucination must not survive DB validation",
    );
  });

  test("mapVisionToDb (live DB): OCR-garbled simvastine rescues to the real ingredient (scaled by similarity)", async () => {
    // Verified against the live branch: similarity('simvastatin','simvastine')
    // = 0.53 (top hit) with a real near-miss (acrivastine 0.35) — the
    // ambiguous-fuzzy lane. All survivors are DB ingredients; the plausible
    // one outranks the near-misses via score = confidence × sim.
    const out = await mapVisionToDb([{ name: "simvastine", lang: "en", confidence: 0.9 }]);
    assert.ok(out.length >= 1, `expected rescue for 'simvastine', got: ${JSON.stringify(out)}`);
    const top = out[0];
    assert.ok(/simvastatin/i.test(top.db_name), `top survivor should be Simvastatin, got ${top.db_name}`);
    assert.equal(top.how, "fuzzy");
    assert.ok(top.confidence < 0.9, "ambiguous rescue must be scaled down by similarity");
    for (const c of out) {
      assert.notEqual(c.llm_name, c.db_name, "display must be DB names, not the garbled OCR string");
    }
  });

  test("mapVisionToDb (live DB): below-threshold garble (asprion→aspirin 0.23) is NOT auto-rescued", async () => {
    const out = await mapVisionToDb([{ name: "asprion", lang: "en", confidence: 0.9 }]);
    assert.equal(out.length, 0, "0.23-similarity must stay a no-match; the user re-taps or re-types");
  });
}
