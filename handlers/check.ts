import type { Bot } from "grammy";
import { queryDdi, fetchDisplayNames } from "../lib/ddi-query";
import {
  parseDrugTokens,
  resolveDrugName,
  type Lang,
  type NameResolution,
} from "../lib/name-resolve";
import {
  renderCheck,
  parseLangInput,
  DEFAULT_LANG,
  DISCLAIMER_LINE,
  EMERGENCY_LINE,
  type CheckRender,
  type ResolvedSlot,
} from "../lib/render";

/**
 * /check handler (P1T7): parse drug names → resolve both → query DDI →
 * render bilingual result with the mandatory safety footer.
 *
 * Pure logic is split out into handleCheckCore so tests can drive it with
 * stub resolvers/queries and no grammY runtime; registerCheckHandlers wires
 * it into the Bot.
 */

/** User UI language per chat; default zh (task contract). */
export const chatLangs = new Map<number, Lang>();

export function getChatLang(chatId: number): Lang {
  const l = chatLangs.get(chatId) ?? DEFAULT_LANG;
  // ja display lands in P3; fall back to en strings (ja resolution input still works).
  return l === "ja" ? "en" : l;
}

export interface CoreDeps {
  resolve: (raw: string, hint: Lang) => Promise<NameResolution>;
  ddi: (idA: string, idB: string) => ReturnType<typeof queryDdi>;
  names: (ids: string[]) => ReturnType<typeof fetchDisplayNames>;
  lang: (chatId: number) => Lang;
}

/** Default deps wired to the live DB modules. */
export const liveDeps: CoreDeps = {
  resolve: resolveDrugName,
  ddi: queryDdi,
  names: fetchDisplayNames,
  lang: getChatLang,
};

/**
 * Core /check pipeline. Returns the rendered message; never throws for
 * query-level problems (rendered as a generic failure with the footer).
 */
export async function handleCheckCore(
  arg: string,
  chatId: number,
  deps: CoreDeps = liveDeps,
): Promise<CheckRender> {
  const tokens = parseDrugTokens(arg);
  if (tokens.length < 2) {
    const r: CheckRender = {
      text:
        "用法 Usage: /check <drug1> <drug2>\n" +
        "Example: /check simvastatin aspirin\n" +
        "(两种药品用空格或逗号分隔)\n\n" +
        [EMERGENCY_LINE, DISCLAIMER_LINE].join("\n"),
      found: false,
      bothResolved: false,
    };
    return r;
  }

  const lang = deps.lang(chatId);
  const [rawA, rawB] = [tokens[0], tokens[1]];
  const [resA, resB] = await Promise.all([
    deps.resolve(rawA, lang),
    deps.resolve(rawB, lang),
  ]);
  const slots: ResolvedSlot[] = [
    { raw: rawA, resolution: resA },
    { raw: rawB, resolution: resB },
  ];

  if (!resA.ingredient_id || !resB.ingredient_id) {
    return renderCheck(slots[0], slots[1], { found: false, pair_count: 0 }, lang as "zh" | "en", {}, lang);
  }

  const ddi = await deps.ddi(resA.ingredient_id, resB.ingredient_id);
  const names = await deps.names([resA.ingredient_id, resB.ingredient_id]);
  return renderCheck(slots[0], slots[1], ddi, lang as "zh" | "en", names, lang);
}

/**
 * Registers /check, /start, /help, /lang on the bot.
 *
 * /start and /help welcome text keeps the existing WELCOME_MESSAGE contract
 * (P1T1) and appends the /lang hint. /lang sets the chat's rendering language
 * (in-memory; webhook workers are stateless across restarts, so the default
 * is zh until a P3 persistent store is added).
 */
export function registerCheckHandlers(bot: Bot, deps: CoreDeps = liveDeps): void {
  bot.command("check", (ctx) =>
    (async () => {
      try {
        const rendered = await handleCheckCore(ctx.match, ctx.chat.id, deps);
        await ctx.reply(rendered.text);
      } catch (err) {
        console.error("/check failed:", err);
        await ctx.reply(
          "❌ 查询失败，请稍后重试 / Query failed, please try again.\n\n" +
            [EMERGENCY_LINE, DISCLAIMER_LINE].join("\n"),
        );
      }
    })(),
  );

  bot.command("lang", (ctx) =>
    (async () => {
      const input = (ctx.match || "").trim();
      if (!input) {
        await ctx.reply(
          "当前语言 Current: " + getChatLang(ctx.chat.id) + "\n" +
            "用法 Usage: /lang en | /lang zh (ja accepted, display follows P3)",
        );
        return;
      }
      const parsed = parseLangInput(input);
      if (!parsed) {
        await ctx.reply("无效语言 Invalid value. Use: /lang en | /lang zh");
        return;
      }
      chatLangs.set(ctx.chat.id, parsed);
      await ctx.reply(`语言已切换 Language set to: ${parsed}`);
    })(),
  );

  const helpText =
    "DDICBot commands\n" +
    "/check <drug1> <drug2> — 查询药物相互作用 (space or comma separated)\n" +
    "/lang en | zh — 设置回复语言 / set reply language\n" +
    "/help — 本帮助 / this help\n" +
    "/start — 欢迎信息 / welcome";
  bot.command("help", (ctx) => ctx.reply(helpText));
  // /start is registered in lib/bot.ts (WELCOME_MESSAGE, P1T1 contract);
  // the welcome text is updated there to include the /help hint.
}

export { DISCLAIMER_LINE, EMERGENCY_LINE };
