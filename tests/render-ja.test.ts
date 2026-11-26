/**
 * P3 final-QA render tests — full ja display + the three pinned not-found
 * strings + mandatory footer on every path.
 *
 * Pinned exact strings (task contract — asserted verbatim):
 *   zh: 数据库未收录该组合，不代表无相互作用。
 *   en: This combination is not in our database
 *        (intentionally shortened from the P1 longer sentence in P3; any
 *        test/expectation that asserted the old sentence was updated here)
 *   ja: この組み合わせはデータベースに収録されていません
 *
 * ja display decisions (documented in lib/render.ts):
 *   - severity badges: 🔴 重大 / 🟡 中度 / 🟢 軽微 / ⚪ 未分類
 *   - mechanism line: 「仕組み: <mechanism_ja>」 when the translation is on
 *     record; otherwise the English-labelled fallback 「Mechanism: <en>」;
 *     otherwise the honest EN placeholder. 「仕組み:」 is the ja mechanism
 *     label used throughout P3.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderCheck,
  parseLangInput,
  EMERGENCY_LINE,
  DISCLAIMER_LINE,
  NOT_IN_DB_ZH,
  NOT_IN_DB_EN,
  NOT_IN_DB_JA,
} from "../lib/render.ts";
import type { DdiResult } from "../lib/ddi-query.ts";
import type { NameResolution } from "../lib/name-resolve.ts";

// ── The pinned strings are exactly the task-specified ones ───────────────

test("P3 pinned: en not-found line is EXACTLY 'This combination is not in our database'", () => {
  assert.equal(NOT_IN_DB_EN, "This combination is not in our database");
  // Deliberate P3 change: the P1 longer sentence
  // ("This combination is not in the database. An absent record is not
  //  evidence of interaction-free use.") is retired; the zh+ja pinned lines
  // carry the honesty semantics, and they are present in every not-found
  // render across all three languages.
});

test("P3 pinned: zh not-found line is EXACTLY '数据库未收录该组合，不代表无相互作用。'", () => {
  assert.equal(NOT_IN_DB_ZH, "数据库未收录该组合，不代表无相互作用。");
});

test("P3 pinned: ja not-found line is EXACTLY 'この組み合わせはデータベースに収録されていません'", () => {
  assert.equal(NOT_IN_DB_JA, "この組み合わせはデータベースに収録されていません");
});

// ── helpers ───────────────────────────────────────────────────────────────

function resolution(id: string): NameResolution {
  return {
    ingredient_id: id,
    confidence: "exact",
    candidates: [],
    matched_surface_name: id,
    matched_lang: "en",
  };
}
const names: Record<string, { en: string[]; zh: string[]; ja: string[] }> = {
  X1: { en: ["Aspirin"], zh: ["阿司匹林"], ja: ["アスピリン"] },
  X2: { en: ["Warfarin"], zh: ["华法林"], ja: ["ワルファリン"] },
};

// ── ja display: severity badges ───────────────────────────────────────────

const FOUND: DdiResult = {
  found: true,
  severity: "Major",
  mechanism_en: "Both drugs affect platelet function; bleeding risk is increased.",
  mechanism_ja: "両薬剤とも血小板機能に影響し、出血リスクを増強する。",
  pair_count: 1,
};

test("ja: Major badge is 🔴 重大, mechanism line is 仕組み: <ja>, footer present", () => {
  const r = renderCheck(
    { raw: "aspirin", resolution: resolution("X1") },
    { raw: "warfarin", resolution: resolution("X2") },
    FOUND,
    "ja",
    names,
  );
  const t = String(r.text);
  assert.equal(r.severity, "Major");
  assert.ok(t.includes("🔴 重大"), `got: ${t}`);
  // The bilingual zh/en badge form must NOT be the one rendered for ja.
  assert.ok(!t.includes("🔴 Major / 严重"), "ja chrome must not fall back to the zh/en badge");
  assert.ok(t.includes("仕組み: 両薬剤とも血小板機能に影響し、出血リスクを増強する。"));
  assert.ok(!t.includes("Mechanism: Both drugs"), "en-labelled line must not appear when ja is on record");
  assert.ok(t.includes(EMERGENCY_LINE));
  assert.ok(t.includes(DISCLAIMER_LINE));
  // ja header: names prefer ja surface forms.
  assert.ok(t.includes("照会 Check:"));
  assert.ok(t.includes("アスピリン"));
});

test("ja: all four badges render 重大/中度/軽微/未分類", () => {
  for (const [sev, badge] of [
    ["Major", "🔴 重大"],
    ["Moderate", "🟡 中度"],
    ["Minor", "🟢 軽微"],
    ["Unknown", "⚪ 未分類"],
  ] as const) {
    const r = renderCheck(
      { raw: "a", resolution: resolution("X1") },
      { raw: "b", resolution: resolution("X2") },
      { found: true, severity: sev, mechanism_en: "m", pair_count: 1 },
      "ja",
      names,
    );
    assert.ok(String(r.text).includes(badge), `${sev} badge must be ${badge}`);
  }
});

test("ja: mechanism_ja absent, mechanism_en present → en-labelled fallback 'Mechanism: <en>'", () => {
  const r = renderCheck(
    { raw: "a", resolution: resolution("X1") },
    { raw: "b", resolution: resolution("X2") },
    { found: true, severity: "Moderate", mechanism_en: "Monitor clotting tests.", mechanism_ja: null, pair_count: 1 },
    "ja",
    names,
  );
  const t = String(r.text);
  assert.ok(t.includes("Mechanism: Monitor clotting tests."), t);
  assert.ok(!t.includes("仕組み:"), "no 仕組み line without ja text on record");
  assert.ok(t.includes(EMERGENCY_LINE));
  assert.ok(t.includes(DISCLAIMER_LINE));
});

test("ja: no mechanism text at all → honest EN placeholder + footer", () => {
  const r = renderCheck(
    { raw: "a", resolution: resolution("X1") },
    { raw: "b", resolution: resolution("X2") },
    { found: true, severity: "Unknown", mechanism_en: null, mechanism_ja: null, pair_count: 1 },
    "ja",
    names,
  );
  const t = String(r.text);
  assert.ok(t.includes("No mechanism text on record in the DDInter bulk source."), t);
  assert.ok(t.includes("⚪ 未分類"));
  assert.ok(t.includes(EMERGENCY_LINE));
  assert.ok(t.includes(DISCLAIMER_LINE));
});

// ── not-found wording per language (exact string + no 'no interaction') ──

const NOTFOUND = { found: false, pair_count: 0 } satisfies DdiResult;

function checkNotFound(lang: "zh" | "en" | "ja", pins: string[]) {
  for (const label of ["resolved pair", "unresolvable", ] as const) {
    const slots =
      label === "resolved pair"
        ? [
            { raw: "aspirin", resolution: resolution("X1") },
            { raw: "metformin", resolution: resolution("X2") },
          ]
        : [
            { raw: "zzzzqqqq", resolution: { confidence: "none" as const, candidates: [] } },
            { raw: "aaabbb", resolution: { confidence: "none" as const, candidates: [] } },
          ];
    const r = renderCheck(slots[0], slots[1], NOTFOUND, lang, names);
    const t = String(r.text);
    for (const p of pins) assert.ok(t.includes(p), `[${lang}/${label}] missing exact string: ${p}\n---\n${t}`);
    assert.ok(!/no interaction/i.test(t), `[${lang}/${label}] must not read 'no interaction'`);
    assert.ok(!/\bsafe\b/i.test(t), `[${lang}/${label}] must not imply 'safe'`);
    assert.ok(t.includes(EMERGENCY_LINE), `[${lang}/${label}] emergency line`);
    assert.ok(t.includes(DISCLAIMER_LINE), `[${lang}/${label}] disclaimer line`);
    // zh + en lines stay present on the other langs (never-drop convention).
    assert.ok(t.includes(NOT_IN_DB_ZH), `[${lang}/${label}] zh line must stay present`);
    assert.ok(t.includes(NOT_IN_DB_EN), `[${lang}/${label}] en line must stay present`);
  }
}

test("notfound zh: exact zh line present (en+ja lines also present)", () => {
  checkNotFound("zh", [NOT_IN_DB_ZH]);
});

test("notfound en: exact en line 'This combination is not in our database'", () => {
  checkNotFound("en", [NOT_IN_DB_EN]);
});

test("notfound ja: exact ja line 'この組み合わせはデータベースに収録されていません'", () => {
  checkNotFound("ja", [NOT_IN_DB_JA]);
});

// ── ja unresolvable re-prompt path ────────────────────────────────────────

test("ja: unresolvable /check renders ja re-prompt + all three not-found lines + footer", () => {
  const r = renderCheck(
    { raw: "zzzzqqqq", resolution: { confidence: "none", candidates: [] } },
    { raw: "aaabbb", resolution: { confidence: "none", candidates: [{ ingredient_id: "Y", surface_name: "Y-thing", sim: 0.42 }] } },
    NOTFOUND,
    "ja",
    names,
  );
  const t = String(r.text);
  assert.ok(t.includes("❓ 以下の薬名を識別できませんでした："));
  assert.ok(t.includes("• zzzzqqqq"), "the raw token is echoed");
  assert.ok(t.includes("• aaabbb"), "the raw token is echoed");
  assert.ok(t.includes("もしくは: Y-thing (類似度 42%)"));
  assert.ok(t.includes(NOT_IN_DB_ZH) && t.includes(NOT_IN_DB_EN) && t.includes(NOT_IN_DB_JA));
  assert.ok(t.includes(EMERGENCY_LINE));
  assert.ok(t.includes(DISCLAIMER_LINE));
  assert.ok(!/no interaction/i.test(t));
});

// ── /lang input parsing (ja is a first-class display language now) ────────

test("parseLangInput: en|zh|ja + aliases", () => {
  assert.equal(parseLangInput("ja"), "ja");
  assert.equal(parseLangInput("日本語"), "ja");
  assert.equal(parseLangInput("Japanese"), "ja");
  assert.equal(parseLangInput("zh"), "zh");
  assert.equal(parseLangInput("中文"), "zh");
  assert.equal(parseLangInput("en"), "en");
  assert.equal(parseLangInput("klingon"), undefined);
});
