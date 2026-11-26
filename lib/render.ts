import type { DdiResult, Severity } from "./ddi-query";
import type { Lang, NameResolution } from "./name-resolve";
import { SEVERITY_RANK } from "./ddi-query";

export const BOT_LANGS: Lang[] = ["en", "zh", "ja"];
export const DEFAULT_LANG: Lang = "zh";

/**
 * UI display language (P3): en, zh AND ja. Since P3T4 ja is a full display
 * language — badges, not-found wording, mechanism line, re-prompt chrome —
 * not only a resolution-input scope.
 */
type UiLang = Lang;

/**
 * The two mandatory lines (project safety rule 1) — present in EVERY
 * user-facing reply, no exceptions. Exported so tests can assert them.
 */
export const EMERGENCY_LINE =
  "⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119）";
export const DISCLAIMER_LINE = "⚠️ 非医疗建议 / Not medical advice";
export const NOT_IN_DB_ZH = "数据库未收录该组合，不代表无相互作用。";
export const NOT_IN_DB_EN = "This combination is not in our database";
export const NOT_IN_DB_JA = "この組み合わせはデータベースに収録されていません";

/**
 * Severity badges per display language. zh/en keep the P2 bilingual
 * "Major / 严重" form; ja uses the pinned 重大/中度/軽微/未分類 labels.
 */
export const SEVERITY_BADGE: Record<Severity, string> = {
  Major: "🔴 Major / 严重",
  Moderate: "🟡 Moderate / 中度",
  Minor: "🟢 Minor / 轻微",
  Unknown: "⚪ Unknown / 未分类",
};
export const SEVERITY_BADGE_JA: Record<Severity, string> = {
  Major: "🔴 重大",
  Moderate: "🟡 中度",
  Minor: "🟢 軽微",
  Unknown: "⚪ 未分類",
};

/**
 * Label for the ja mechanism line (P3 decision): 仕組み: — the plain
 * Japanese word for "how it works / mechanism". The en fallback keeps the
 * English label "Mechanism:" when mechanism_ja is not yet on record.
 */
const MECH_LABEL_JA = "仕組み:";

export interface ResolvedSlot {
  raw: string;
  resolution: NameResolution;
}

interface DisplayNames {
  en: string[];
  zh: string[];
  ja: string[];
}

export interface CheckRender {
  text: string;
  severity?: Severity;
  found: boolean;
  bothResolved: boolean;
}

function footer(lang: UiLang): string {
  // Order: emergency line first (most critical), disclaimer second.
  // Both lines are bilingual-by-content and render verbatim in every
  // display language — lang picks only the surrounding chrome.
  return [EMERGENCY_LINE, DISCLAIMER_LINE].join("\n");
}

/**
 * Not-found wording (safety rule 2: never "no interaction" / "safe").
 * The pinned line for the current language comes first; the other two
 * language lines stay present too (the never-drop convention, mirroring the
 * footer). This is what makes the exact-string asserts hold in all three.
 */
function notFoundBlock(lang: UiLang): string {
  const all: [string, Lang][] = [
    [NOT_IN_DB_ZH, "zh"],
    [NOT_IN_DB_EN, "en"],
    [NOT_IN_DB_JA, "ja"],
  ];
  const ordered = [
    all.find(([, l]) => l === lang)!,
    ...all.filter(([, l]) => l !== lang),
  ];
  return ordered.map(([s]) => s).join("\n");
}

function pairHeader(
  aRaw: string,
  aNames: DisplayNames | undefined,
  bRaw: string,
  bNames: DisplayNames | undefined,
  lang: UiLang,
): string {
  const pick = (names: DisplayNames | undefined, raw: string): string => {
    if (!names) return raw;
    const list =
      lang === "zh"
        ? [names.zh, names.en]
        : lang === "ja"
          ? [names.ja, names.en, names.zh]
          : [names.en, names.zh];
    for (const l of list) {
      const first = l.find((s) => s.length > 0);
      if (first) return `${raw} → ${first}`;
    }
    return raw;
  };
  const label = lang === "ja" ? "照会 Check:" : "查询 Query:";
  return `${label} ${pick(aNames, aRaw)}  ×  ${pick(bNames, bRaw)}`;
}

/**
 * Mechanism line per language. Never drop the mechanism, never imply absence:
 *  - zh: 机制: <zh> → 机制说明（英文）: <en> → honest zh placeholder
 *  - en: Mechanism: <en> → honest en placeholder
 *  - ja: 仕組み: <ja> → "Mechanism: <en>" (en-labelled fallback) →
 *        the en placeholder line (mechanism_ja coverage is partial by design;
 *        the en source text stays the fallback of record)
 */
function mechanismLine(ddi: DdiResult, lang: UiLang): string {
  const hasZh = Boolean(ddi.mechanism_zh && ddi.mechanism_zh.trim());
  const hasJa = Boolean(ddi.mechanism_ja && ddi.mechanism_ja.trim());
  const hasEn = Boolean(ddi.mechanism_en && ddi.mechanism_en.trim());
  if (lang === "zh") {
    if (hasZh) return `机制: ${ddi.mechanism_zh}`;
    if (hasEn) return `机制说明（英文）: ${ddi.mechanism_en}`;
    return "来源未提供机制说明 (no mechanism text on record in DDInter bulk).";
  }
  if (lang === "ja") {
    if (hasJa) return `${MECH_LABEL_JA} ${ddi.mechanism_ja}`;
    if (hasEn) return `Mechanism: ${ddi.mechanism_en}`;
    return "No mechanism text on record in the DDInter bulk source.";
  }
  // en
  if (hasEn) return `Mechanism: ${ddi.mechanism_en}`;
  return "No mechanism text on record in the DDInter bulk source.";
}

/**
 * Render the /check result. Every output path — found, not-found, unresolvable,
 * and the usage path in handlers/check.ts — carries the mandatory emergency +
 * disclaimer lines. The not-found path renders "未收录 / not in our database /
 * 収録されていません" wording — never "no interaction" / "safe".
 */
export function renderCheck(
  a: ResolvedSlot,
  b: ResolvedSlot,
  ddi: DdiResult,
  lang: UiLang,
  names: Record<string, DisplayNames>,
): CheckRender {
  if (!a.resolution.ingredient_id || !b.resolution.ingredient_id) {
    const bad = [a, b].filter((s) => !s.resolution.ingredient_id);
    const lines: string[] = [];
    if (lang === "zh") {
      lines.push("❓ 无法识别以下药品名称：");
      for (const s of bad) {
        lines.push(`• ${s.raw}`);
        for (const c of s.resolution.candidates.slice(0, 3)) {
          lines.push(`  可能指: ${c.surface_name} (相似 ${Math.round(c.sim * 100)}%)`);
        }
        if (s.resolution.candidates.length === 0) lines.push("  没有近似候选。");
      }
      lines.push("\n请重新输入药品名（用空格或逗号分隔两种），或发送药盒照片。\nUsage: /check <drug1> <drug2>");
    } else if (lang === "ja") {
      lines.push("❓ 以下の薬名を識別できませんでした：");
      for (const s of bad) {
        lines.push(`• ${s.raw}`);
        for (const c of s.resolution.candidates.slice(0, 3)) {
          lines.push(`  もしくは: ${c.surface_name} (類似度 ${Math.round(c.sim * 100)}%)`);
        }
        if (s.resolution.candidates.length === 0) lines.push("  類似の候補がありません。");
      }
      lines.push("\n薬名を再入力してください（2つをスペースまたはカンマで区切る）、または薬箱の写真を送ってください。\nUsage: /check <drug1> <drug2>");
    } else {
      lines.push("❓ Could not recognize the following drug name(s):");
      for (const s of bad) {
        lines.push(`• ${s.raw}`);
        for (const c of s.resolution.candidates.slice(0, 3)) {
          lines.push(`  maybe: ${c.surface_name} (similarity ${Math.round(c.sim * 100)}%)`);
        }
        if (s.resolution.candidates.length === 0) lines.push("  no close candidates found.");
      }
      lines.push("\nPlease re-type the drug names (space or comma separated), or send a photo.\n用法: /check <drug1> <drug2>");
    }
    // Acceptance contract: an unresolved /check reply must still state the
    // not-in-database wording (it must never read as "no interaction").
    lines.push("\n" + notFoundBlock(lang));
    lines.push("", footer(lang));
    return { text: lines.join("\n"), found: false, bothResolved: false };
  }

  const aId = a.resolution.ingredient_id!;
  const bId = b.resolution.ingredient_id!;
  const head = [pairHeader(a.raw, names[aId], b.raw, names[bId], lang)];

  if (!ddi.found) {
    // SAFETY RULE: not-in-DB ≠ no interaction. Exact phrasing is pinned.
    head.push("\n" + notFoundBlock(lang));
    head.push("", footer(lang));
    return { text: head.join("\n"), found: false, bothResolved: true };
  }

  const sev = ddi.severity as Severity;
  head.push(
    `\n${lang === "ja" ? SEVERITY_BADGE_JA[sev] : SEVERITY_BADGE[sev]}`,
  );
  head.push(mechanismLine(ddi, lang));
  head.push("", footer(lang));
  return { text: head.join("\n"), severity: sev, found: true, bothResolved: true };
}

/**
 * Pure text classifier for the /lang command input. Accepts the three
 * display languages (en|zh|ja) plus common aliases. Since P3T4 ja renders
 * full Japanese chrome (badges, not-found, mechanism line).
 */
export function parseLangInput(raw: string): Lang | undefined {
  const t = raw.trim().toLowerCase();
  if (t === "zh" || t === "cn" || t === "chinese" || t === "中文" || t === "ch") return "zh";
  if (t === "en" || t === "english" || t === "英语" || t === "en-us") return "en";
  if (t === "ja" || t === "japanese" || t === "日语" || t === "日本語") return "ja";
  return undefined;
}

export { SEVERITY_RANK };
