import type { Bot, Context } from "grammy";
import {
  DISCLAIMER_LINE,
  EMERGENCY_LINE,
  renderCheck,
  type ResolvedSlot,
} from "../lib/render";
import {
  extractCandidates,
  VisionError,
  VisionNotConfiguredError,
  VISION_MAX_CANDIDATES,
  type VisionCandidate,
} from "../lib/vision";
import type { Lang } from "../lib/name-resolve";
import { mapVisionToDb, type MappedCandidate } from "../lib/vision-map";
import {
  fetchPhotoBytes,
  PhotoDownloadError,
  type FetchedPhoto,
} from "../lib/vision-dl";
import { clearPending, confirm, getPending, setPending } from "../lib/photo-state";
import { queryDdi, fetchDisplayNames, type DdiResult } from "../lib/ddi-query";
import { loadEnv } from "../lib/env";
import { getChatLang } from "./check";

/**
 * Photo → vision candidates → inline-keyboard confirm → DDI (P2T2).
 *
 * SAFETY ARCHITECTURE — never auto-match (safety rule 3, non-negotiable):
 * The onPhoto path is CLOSED to the DDI table. Its dependency surface
 * (PhotoDeps) deliberately contains NO `ddi` function — a photo can only
 * ever produce an inline keyboard. The single DDI call site in the whole
 * flow is `runPhotoDdi()`, reachable only from the callback_query handler,
 * i.e. only after a real button tap confirms BOTH ingredient_ids via
 * photo-state.confirm's readyForDdi flag. Proof: tests/photo-flow.test.ts —
 * a photo update that never receives a tap fires zero ddi() calls.
 *
 * PII HYGIENE (safety rule 4): photo bytes are fetched in-memory
 * (lib/vision-dl.ts), sent to the vision LLM as a base64 data: URL, and
 * dropped after the reply — no fs, no temp files, no DB column ever holds
 * image bytes (static assertion: tests/pii-hygiene.test.ts).
 */

/** Dependency surface for the onPhoto path. NOTE: no `ddi` member — the
 *  photo path cannot query the interaction table, by construction. */
export interface PhotoDeps {
  /** Download a photo into memory (injected for test stubbing). */
  fetch: (fileId: string) => Promise<FetchedPhoto>;
  /** Vision LLM call (lib/vision.extractCandidates in production). */
  vision: (bytes: Uint8Array, mime: string) => Promise<VisionCandidate[]>;
  /** LLM names → DB-validated candidates. */
  map: (raw: VisionCandidate[], hint: Lang) => Promise<MappedCandidate[]>;
  /** Chat display-language resolver. */
  lang: (chatId: number) => Lang;
}

/** Production deps: real Bot API download, real Kimi vision, real DB resolve. */
export const livePhotoDeps: PhotoDeps = {
  fetch: (fileId) =>
    fetchPhotoBytes(loadEnv().botToken ?? "ddicbot:local-placeholder", fileId),
  vision: extractCandidates,
  map: mapVisionToDb,
  lang: (chatId) => getChatLang(chatId),
};

export interface DdiDeps {
  ddi: (idA: string, idB: string) => Promise<DdiResult>;
  names: (
    ids: string[],
  ) => Promise<Record<string, { en: string[]; zh: string[]; ja: string[] }>>;
}

/** Production DDI deps — the live DB-backed implementations. */
export const liveDdiDeps: DdiDeps = { ddi: queryDdi, names: fetchDisplayNames };

const footer = [EMERGENCY_LINE, DISCLAIMER_LINE].join("\n");

function buttonData(id: string): string {
  // callback_data budget is 64 bytes: "ddic:pick:" (10) + id (~11) fits.
  return `ddic:pick:${id}`;
}
const NONE_DATA = "ddic:none";

/** Inline keyboard: one row per candidate (≤5) + a "none of these" row. */
export function candidateKeyboard(cands: MappedCandidate[]): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  const rows = cands.slice(0, VISION_MAX_CANDIDATES).map((c) => [
    {
      text: `${c.db_name} (${Math.round(c.confidence * 100)}%)`,
      callback_data: buttonData(c.ingredient_id),
    },
  ]);
  rows.push([{ text: "❌ None of these / 都不是", callback_data: NONE_DATA }]);
  return { inline_keyboard: rows };
}

export interface PhotoCoreOut {
  text: string;
  candidates: MappedCandidate[];
}

/**
 * Core photo pipeline (grammY-free — driven purely by `deps`).
 * bytes → LLM candidates → DB validation → keyboard-ready output.
 * An empty `candidates` list means "no drug identified".
 */
export async function handlePhotoCore(
  bytes: Uint8Array,
  mime: string,
  chatId: number,
  deps: PhotoDeps = livePhotoDeps,
): Promise<PhotoCoreOut> {
  await setPending(chatId); // (re)start the confirmation session for this chat
  const raw = await deps.vision(bytes, mime);
  const mapped = await deps.map(raw, deps.lang(chatId));
  if (mapped.length === 0) {
    return {
      text:
        "📷 未识别到药品 / No drug identified.\n" +
        "未能从照片中确认任何已知药品名（图像识别结果须经数据库核实，未核实不展示）。\n" +
        "Please type the drug names instead — /check <drug1> <drug2>\n\n" +
        footer,
      candidates: [],
    };
  }
  const lang = deps.lang(chatId);
  let lines =
    lang === "zh"
      ? "📷 照片识别完成。点选你正在使用的药品（最多两种；选满两种自动查询相互作用）：\n"
      : "📷 Photo processed. Tap the drug(s) you are using (up to 2; once two are selected the interaction check runs):";
  for (const c of mapped) {
    lines += `• ${c.db_name} (${Math.round(c.confidence * 100)}%)\n`;
  }
  lines +=
    "\n如都不是：点 “❌ None of these / 都不是”，或改用 /check <drug1> <drug2>\n\n" +
    footer;
  return { text: lines, candidates: mapped };
}

/**
 * Run the interaction query for two user-CONFIRMED ingredients.
 *
 * THE ONE DDI CALL SITE OF THE PHOTO FLOW. Its only caller is the
 * callback handler, and only after `confirm()` returned readyForDdi=true,
 * which requires two distinct explicit user taps on DB-verified candidates.
 * No other path in this module (or the onPhoto path) can reach the DDI
 * table.
 */
export async function runPhotoDdi(
  a: { id: string; label: string },
  b: { id: string; label: string },
  chatId: number,
  deps: DdiDeps,
  lang: "en" | "zh",
): Promise<string> {
  const ddi = await deps.ddi(a.id, b.id);
  const names = await deps.names([a.id, b.id]);
  const slot = (x: { id: string; label: string }): ResolvedSlot => ({
    raw: x.label,
    resolution: {
      ingredient_id: x.id,
      // "exact": the id was user-tapped from a DB-verified candidate, not
      // fuzzy-guessed — the highest-confidence class this flow can produce.
      confidence: "exact",
      candidates: [],
      matched_surface_name:
        names[x.id]?.zh?.[0] ?? names[x.id]?.en?.[0] ?? names[x.id]?.ja?.[0] ?? x.label,
      matched_lang: lang,
    },
  });
  const rendered = renderCheck(slot(a), slot(b), ddi, lang, names);
  await clearPending(chatId); // session consumed by its query
  return rendered.text;
}

export interface PhotoHandlerDeps {
  photo: PhotoDeps;
  ddi: DdiDeps;
}

const defaultDeps: PhotoHandlerDeps = { photo: livePhotoDeps, ddi: liveDdiDeps };

/** Registers the onPhoto handler and the ddic:* callback_query handlers. */
export function registerPhotoHandlers(bot: Bot, deps: PhotoHandlerDeps = defaultDeps): void {
  // ------------------------------------------------------------- onPhoto
  bot.on("message:photo", (ctx) =>
    (async () => {
      const chatId = ctx.chat.id;
      const sizes = ctx.message.photo;
      if (!sizes || sizes.length === 0) return;
      const largest = sizes[sizes.length - 1]; // largest size = best OCR surface
      await ctx.reply("📷 已收到照片，正在识别中（几秒）... Photo received, processing...\n\n" + footer);
      try {
        const { bytes, mime } = await deps.photo.fetch(largest.file_id);
        const out = await handlePhotoCore(bytes, mime, chatId, deps.photo);
        // `bytes` leaves scope here — transient, never persisted or logged.
        if (out.candidates.length === 0) {
          await ctx.reply(out.text);
          return;
        }
        await ctx.reply(out.text, { reply_markup: candidateKeyboard(out.candidates) });
      } catch (err) {
        await reportPhotoFailure(ctx, err);
      }
    })(),
  );

  // ------------------------------------- callbacks: the only DDI doorway
  bot.on("callback_query", (ctx) =>
    (async () => {
      const data = ctx.callbackQuery?.data;
      if (!data || !data.startsWith("ddic:")) return; // not a photo-flow callback
      // GrammY types ctx.chat as possibly-absent on unfiltered callbacks; in
      // practice every callback_query update carries chat + from.
      if (!ctx.chat) return;
      const chatId: number = ctx.chat.id;
      const ack = (t?: string) => ctx.answerCallbackQuery(t).catch(() => {});
      const hadKeyboard = !!(
        ctx.message && (ctx.message as { reply_markup?: unknown }).reply_markup
      );
      const say = (text: string) =>
        hadKeyboard
          ? ctx.editMessageText(text).catch(() => ctx.reply(text))
          : ctx.reply(text);

      if (data === NONE_DATA) {
        await clearPending(chatId);
        await ack();
        await say(
          "↩️ 已取消该照片识别 / Cancelled.\n" +
            "如确为药品，请用文字输入 Check typed: /check <drug1> <drug2>\n\n" +
            footer,
        );
        return;
      }

      const m = data.match(/^ddic:pick:(.+)$/);
      if (!m) return;
      const id = m[1];

      const pending = await getPending(chatId);
      if (!pending) {
        await ack("会话已过期，请重新发送照片 / session expired, re-send the photo");
        return;
      }

      // Display name straight from the DB (drug_names) — the LLM string is
      // never presented as an identity on its own.
      const names = await deps.ddi.names([id]);
      const db_name =
        names[id]?.zh?.[0] ?? names[id]?.en?.[0] ?? names[id]?.ja?.[0] ?? id;

      const res = await confirm(chatId, id, db_name);
      if (!res.ok) {
        await ack("会话已过期，请重新发送照片 / session expired, re-send the photo");
        return;
      }
      if (res.duplicate) {
        await ack("已选过这个药 / already selected");
        return;
      }
      if (!res.readyForDdi) {
        await ack(`已确认 1/2: ${db_name} / 1 of 2 confirmed`);
        await say(
          `✅ 已确认 1/2: ${db_name}\n` +
            `请发送第二种药的照片并点选 / Now send the SECOND drug's photo and tap it.\n\n` +
            footer,
        );
        return;
      }

      // TWO distinct explicit taps on record: the one DDI call site fires.
      const [a, b] = res.confirmed;
      await ack("查询中 / querying...");
      try {
        // getChatLang maps ja→en internally (see handlers/check.ts), so the
        // returned value is structurally "en"|"zh". Map ConfirmedDrug → the
        // {id, label} display shape runPhotoDdi renders from.
        const text = await runPhotoDdi(
          { id: a.id, label: a.canonicalName },
          { id: b.id, label: b.canonicalName },
          chatId,
          deps.ddi,
          getChatLang(chatId) as "en" | "zh",
        );
        await say(text);
      } catch (err) {
        console.error("photo ddi query failed:", err instanceof Error ? err.message : err);
        await say("❌ 查询失败，请稍后重试 / Query failed, please try again.\n\n" + footer);
      }
    })(),
  );
}

/** User-safe failure messages for the onPhoto path (no bytes, no dumps). */
async function reportPhotoFailure(ctx: Context, err: unknown): Promise<void> {
  let msg: string;
  if (err instanceof VisionNotConfiguredError) {
    msg =
      "📷 照片识别功能尚未在此部署启用（vision key 未配置）。\n" +
      "Please type the drug names — /check <drug1> <drug2>\n\n" +
      footer;
  } else if (err instanceof PhotoDownloadError) {
    msg = `📷 照片下载失败，请重拍 / photo download failed, please retry: ${err.message}\n\n` + footer;
  } else if (err instanceof VisionError) {
    // VisionError messages carry only provider-side text — never image bytes.
    msg = `📷 识别失败，请稍后重试 / identification failed, please retry: ${err.message}\n\n` + footer;
  } else {
    console.error("photo handler failed:", err instanceof Error ? err.message : err);
    msg = "📷 照片处理出错，请重试 / photo processing error, please retry.\n\n" + footer;
  }
  try {
    await ctx.reply(msg);
  } catch {
    /* delivery already broken; log-only */
  }
}
