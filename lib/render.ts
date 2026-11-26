import type { DdiResult, Severity } from "./ddi-query";
import type { Lang, NameResolution } from "./name-resolve";
import { SEVERITY_RANK } from "./ddi-query";

export const BOT_LANGS: Lang[] = ["zh", "en"];
export const DEFAULT_LANG: Lang = "zh";

type UiLang = Exclude<Lang, "ja">; // P1 UI languages are zh/en; ja rows exist in
// the name dict for resolution input but are not a display language until P3.

/**
 * The two mandatory lines (project safety rule 1) — present in EVERY
 * user-facing reply, no exceptions. Exported so tests can assert them.
 */
export const EMERGENCY_LINE =
  "⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119）";
export const DISCLAIMER_LINE = "⚠️ 非医疗建议 / Not medical advice";
export const NOT_IN_DB_ZH = "数据库未收录该组合，不代表无相互作用。";
export const NOT_IN_DB_EN =
  "This combination is not in the database. An absent record is not evidence of interaction-free use.";

export const SEVERITY_BADGE: Record<Severity, string> = {
  Major: "🔴 Major / 严重",
  Moderate: "🟡 Moderate / 中度",
  Minor: "🟢 Minor / 轻微",
  Unknown: "⚪ Unknown / 未分类",
};

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
  // Both lines are always bilingual-by-content; lang only picks ordering
  // of the surrounding chrome, never drops a line.
  return [EMERGENCY_LINE, DISCLAIMER_LINE].join("\n");
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
    const list = lang === "zh" ? [names.zh, names.en] : [names.en, names.zh];
    for (const l of list) {
      const first = l.find((s) => s.length > 0);
      if (first) return `${raw} → ${first}`;
    }
    return raw;
  };
  return `查询 Query: ${pick(aNames, aRaw)}  ×  ${pick(bNames, bRaw)}`;
}

/**
 * Render the /check result. Every output path carries the mandatory
 * emergency + disclaimer lines. The not-found path renders "未收录"
 * wording — never "no interaction" / "safe".
 */
export function renderCheck(
  a: ResolvedSlot,
  b: ResolvedSlot,
  ddi: DdiResult,
  lang: UiLang,
  names: Record<string, DisplayNames>,
  /** P3T2: language of the user's query. When it is "ja" (or the display
   *  language has a stored translation for that language) the mechanism line
   *  uses mechanism_ja instead of English, per the card's "if
   *  mechanism_zh/mechanism_ja exists, show the translated version". The rest
   *  of the chrome (badges, not-found, footer) stays on the P2 zh/en design —
   *  a full ja UI is P3T4's scope and is NOT invented here. */
  mechLang: Lang = lang,
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
    if (lang === "zh") lines.push("\n" + NOT_IN_DB_ZH + "\n" + NOT_IN_DB_EN);
    else lines.push("\n" + NOT_IN_DB_EN + "\n" + NOT_IN_DB_ZH);
    lines.push("", footer(lang));
    return { text: lines.join("\n"), found: false, bothResolved: false };
  }

  const aId = a.resolution.ingredient_id!;
  const bId = b.resolution.ingredient_id!;
  const head = [pairHeader(a.raw, names[aId], b.raw, names[bId], lang)];

  if (!ddi.found) {
    // SAFETY RULE: not-in-DB ≠ no interaction. Exact phrasing is pinned.
    if (lang === "zh") {
      head.push(`\n${NOT_IN_DB_ZH}\n${NOT_IN_DB_EN}`);
    } else {
      head.push(`\n${NOT_IN_DB_EN}\n${NOT_IN_DB_ZH}`);
    }
    head.push("", footer(lang));
    return { text: head.join("\n"), found: false, bothResolved: true };
  }

  const sev = ddi.severity as Severity;
  head.push(`\n${SEVERITY_BADGE[sev]}`);
  const hasZh = Boolean(ddi.mechanism_zh && ddi.mechanism_zh.trim());
  const hasJa = Boolean(ddi.mechanism_ja && ddi.mechanism_ja.trim());
  const hasEn = Boolean(ddi.mechanism_en && ddi.mechanism_en.trim());
  if (lang === "zh") {
    if (hasZh) {
      // P3T2: show the translated version when it is on record.
      head.push(`机制: ${ddi.mechanism_zh}`);
    } else if (hasEn) {
      // Translation not yet covered this pair — show the English source and
      // label it plainly. Never drop the mechanism, never imply absence.
      head.push(`机制说明（英文）: ${ddi.mechanism_en}`);
    } else {
      head.push("来源未提供机制说明 (no mechanism text on record in DDInter bulk).");
    }
  } else if (mechLang === "ja" && hasJa) {
    // A Japanese-language query asks for the mechanism in Japanese when it is
    // on record. Display chrome stays English (P2) — only the mechanism line
    // is localized, per the P3T2 contract.
    head.push(`Mechanism (JA): ${ddi.mechanism_ja}`);
  } else if (hasEn) {
    head.push(`Mechanism: ${ddi.mechanism_en}`);
  } else {
    head.push("No mechanism text on record in the DDInter bulk source.");
  }
  head.push("", footer(lang));
  return { text: head.join("\n"), severity: sev, found: true, bothResolved: true };
}

/**
 * Pure text classifier for the /lang command input (en|zh|ja accepted).
 * Display: zh renders Chinese chrome, en English chrome, ja English chrome
 * with a Japanese mechanism line when the translation is on record (P3T2);
 * a full ja UI is P3T4's scope.
 */
export function parseLangInput(raw: string): Lang | undefined {
  const t = raw.trim().toLowerCase();
  if (t === "zh" || t === "cn" || t === "chinese" || t === "中文" || t === "ch") return "zh";
  if (t === "en" || t === "english" || t === "英语" || t === "en-us") return "en";
  if (t === "ja" || t === "japanese" || t === "日语") return "ja";
  return undefined;
}

export { SEVERITY_RANK };
